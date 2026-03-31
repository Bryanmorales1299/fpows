import { FastMCP } from 'fastmcp';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import dotenv from 'dotenv';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import express from 'express';

// Load .env if not in production
if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

// Utility to clean environment variables
const cleanEnv = (val, defaultValue = "") => {
    if (!val || val === "undefined" || val === "null" || val === "") return defaultValue;
    return val.toString().replace(/[^\x20-\x7E]/g, '').trim().replace(/^"|"$/g, '');
};

// Configuration from Environment Variables
const SIMPRO_BASE_URL = cleanEnv(process.env.SIMPRO_BASE_URL);
const SIMPRO_ACCESS_TOKEN = cleanEnv(process.env.SIMPRO_ACCESS_TOKEN);
const COMPANY_ID = cleanEnv(process.env.SIMPRO_COMPANY_ID, "1");
const SMTP_USER = cleanEnv(process.env.SMTP_USER);
const SMTP_PASS = cleanEnv(process.env.SMTP_PASS);
const MANAGER_EMAIL = cleanEnv(process.env.MANAGER_EMAIL);

if (!SIMPRO_BASE_URL || !SIMPRO_ACCESS_TOKEN) {
    console.error("[CRITICAL] Missing SIMPRO_BASE_URL or SIMPRO_ACCESS_TOKEN in environment.");
}

// Reusable SMTP transporter (created once, connection pooled)
let emailTransporter = null;
function getTransporter() {
    if (!emailTransporter && SMTP_USER && SMTP_PASS) {
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: SMTP_USER, pass: SMTP_PASS },
            pool: true,
            maxConnections: 3,
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 30000,
        });
        console.log('[SMTP] Transporter created with pooling and timeouts.');
    }
    return emailTransporter;
}

// Simple retry helper for sending email
async function sendMailWithRetry(transporter, mailOptions, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const info = await transporter.sendMail(mailOptions);
            return info;
        } catch (err) {
            console.error(`[SMTP] Attempt ${attempt + 1} failed: ${err.message}`);
            if (attempt < retries) {
                console.log(`[SMTP] Retrying in 2s...`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw err;
            }
        }
    }
}

const getSimpro = async (path) => {
    if (!SIMPRO_BASE_URL) throw new Error("SIMPRO_BASE_URL not configured");
    const rawUrl = `${SIMPRO_BASE_URL.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
    console.log(`[simPRO FETCH] URL: ${rawUrl}`);
    try {
        const validatedUrl = new URL(rawUrl).toString();
        const response = await axios.get(validatedUrl, {
            headers: {
                'Authorization': `Bearer ${SIMPRO_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 15000 
        });
        console.log(`[simPRO SUCCESS] ${path} -> ${response.status}`);
        return response;
    } catch (urlErr) {
        console.error(`[simPRO ERROR] ${path} -> ${urlErr.message}`);
        throw urlErr;
    }
};

// Initialize FastMCP Server
const mcp = new FastMCP({
    name: "simPRO FPOWS Automation",
    version: "1.0.0"
});

/**
 * Shared logic for data aggregation
 * Can be called by MCP tool or REST API
 */
const fetchFpowData = async (jobId) => {
    const jobRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${jobId}`);
    const jobData = jobRes.data;

    // 1. Site Info
    let siteName = jobData.Site?.Name || "Site Details Not Found";
    
    // 2. Contact Parse
    let contactSource = jobData.Contact?.Name ? "simpro_direct" : "not_found";
    const desc = jobData.Description || "";
    const nameMatch = desc.match(/Name:\s*([^<\n\r]+)/i);
    const phoneMatch = desc.match(/Phone[^:]*:\s*([^<\n\r]+)/i);
    const emailMatch = desc.match(/Email:\s*([^<\n\r]+)/i);

    let contactName = jobData.Contact?.Name || (nameMatch ? (contactSource="description", nameMatch[1].trim()) : "");
    let contactPhone = jobData.Contact?.Phone || (phoneMatch ? (contactSource="description", phoneMatch[1].trim()) : "");
    let contactEmail = jobData.Contact?.Email || (emailMatch ? (contactSource="description", emailMatch[1].trim()) : "");

    if (!contactName && jobData.Site?.ID) {
        try {
            const scRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/sites/${jobData.Site.ID}/contacts/`);
            if (scRes.data && scRes.data.length > 0) {
                contactName = `${scRes.data[0].GivenName || ''} ${scRes.data[0].FamilyName || ''}`.trim();
                contactSource = "site_contacts";
            }
        } catch (e) {}
    }

    // 3. Customer Info
    let clientName = jobData.Customer?.CompanyName || jobData.Customer?.Name || "Client Not Found";
    if (jobData.Customer?.ID) {
        try {
            const custRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/customers/${jobData.Customer.ID}`);
            const cust = custRes.data;
            clientName = cust.CompanyName || `${cust.GivenName || ''} ${cust.FamilyName || ''}`.trim() || clientName;
        } catch (e) {}
    }

    // 4. Site-Wide Aggregation
    const siteId = jobData.Site ? jobData.Site.ID : null;
    const outstandingWorks = [];

    if (siteId) {
        try {
            const jobsRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/?Site.ID=${siteId}&pageSize=50`);
            if (jobsRes.data && jobsRes.data.length > 0) {
                const jobDetails = await Promise.all(jobsRes.data.map(async (j) => {
                    try {
                        const detailRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${j.ID}`);
                        const dj = detailRes.data;
                        
                        // STRICT STATUS FILTER: Whitelist ONLY Pending and Progress
                        if (dj.Stage) {
                            const st = dj.Stage.toLowerCase();
                            if (!(st.includes('pending') || st.includes('progress'))) {
                                return null;
                            }
                        }
                        
                        // CLIENT POV DISTILLER: Extract the core task and notes, hide the template boilerplate
                        function cleanDescriptionForClient(desc) {
                            if (!desc) return "Standard maintenance and inspection.";
                            
                            // 1. Initial cleanup
                            const clean = desc.replace(/<br\s*\/?>/gi, '\n')
                                              .replace(/<\/p>|<\/div>/gi, '\n')
                                              .replace(/<[^>]+>/g, '')
                                              .replace(/[ \t]+/g, ' ')
                                              .trim();
                            
                            // 2. Split into lines and filter
                            const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
                            const filtered = lines.filter(line => {
                                // Ignore standard Redmen boilerplate lines
                                const p = line.toLowerCase();
                                if (p.startsWith('techs attending:')) return false;
                                if (p.startsWith('attendance confirmed')) return false;
                                if (p.startsWith('name:')) return false;
                                if (p.startsWith('phone')) return false; // Catches 'Phone Number:'
                                if (p.startsWith('email:')) return false;
                                if (p.startsWith('address:')) return false;
                                if (p.startsWith('site address:')) return false;
                                if (p.startsWith('site:')) return false;
                                if (p.startsWith('contact:')) return false;
                                if (p.includes('my link ly')) return false; // Common template name
                                if (p.includes('******quote number:')) return false;
                                if (p.startsWith('scheduled time:')) return false;
                                if (p.startsWith('scheduled date:')) return false;
                                if (p.startsWith('osa name:')) return false;
                                if (p.startsWith('access instructions:')) return false;
                                if (p.startsWith('materials / specialty tools')) return false;
                                if (p.startsWith('materials location:')) return false;
                                if (p.includes('redmen fire protection scope of works')) return false;
                                if (p.includes('qualified technician to attend')) return false;
                                if (p.includes('as/nz 1668')) return false;
                                if (p.includes('bca ci part e2')) return false;
                                if (p.includes('witness testing of essential fans')) return false;
                                if (p.includes('operation checks of mechanical equipment')) return false;
                                if (p.includes('reporting and certification')) return false;
                                if (p.includes('sell price:')) return false;
                                if (p.includes('quoted by:')) return false;
                                if (p.includes('requested by:')) return false;
                                if (p === 'scope of works:') return false;
                                return true;
                            });

                            // 3. Join back with nice formatting
                            if (filtered.length === 0) return "General Fire Safety Inspection / Routine Testing";
                            
                            // Limit to 15 lines max to keep the table manageable
                            return filtered.slice(0, 15).join('\n');
                        }

                        const rawDesc = (dj.Description || "");
                        const descFormatted = cleanDescriptionForClient(rawDesc);
                        
                        // Determine a professional [STATUS] for the client POV
                        let displayStatus = 'PENDING';
                        if (dj.Stage) {
                            const stage = dj.Stage.toLowerCase();
                            if (stage.includes('progress')) displayStatus = 'IN PROGRESS';
                            if (stage.includes('complete')) displayStatus = 'COMPLETED';
                        }
                        if (rawDesc.toLowerCase().includes('scheduled for')) displayStatus = 'SCHEDULED';

                        
                        let sq = dj.Quote ? dj.Quote.ID : "";

                        // Robust Equipment Type Lookup: Prioritize Job/Service Name over Cost Center
                        let rawEq = (dj.Service?.Name || dj.Name || "").trim();
                        // If the name is just a number (like a Quote ID), it's not a valid Equipment Type; ignore it.
                        let eqType = /^\d+$/.test(rawEq) ? "" : rawEq;
                        
                        // If empty, too generic, or was a number, try digging into Cost Centers
                        if (!eqType || eqType.toLowerCase().includes("general")) {
                            try {
                                const secRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${j.ID}/sections/`);
                                if (secRes.data && secRes.data.length > 0) {
                                    for (const section of secRes.data) {
                                        const ccRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${j.ID}/sections/${section.ID}/costCenters/`);
                                        if (ccRes.data && ccRes.data.length > 0) {
                                            for (const cc of ccRes.data) {
                                                const rawName = cc.Name || cc.CostCenter?.Name || "";
                                                if (rawName && !rawName.toLowerCase().includes("general")) {
                                                    // Strip accounting noise: Division, Income, Sales, etc.
                                                    eqType = rawName.replace(/\s*(?:Division|Sales|Income|Division Income|Center)\s*$/i, "").trim();
                                                    break;
                                                }
                                            }
                                        }
                                        if (eqType && !eqType.toLowerCase().includes("general")) break;
                                    }
                                }
                            } catch (e) {}
                        }

                        // Final fallback to raw name if cost center didn't help (at least we tried)
                        if (!eqType) eqType = rawEq || "Service Job";



                        // DARN Search
                        let darnVal = "";
                        let darnSource = "";
                        const darnMatch = (dj.Description || "").match(/DARN\W*(?:form|no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                        if (darnMatch) { darnVal = darnMatch[1]; darnSource = "description"; }
                        
                        // Lead Search
                        let leadVal = dj.Lead ? dj.Lead.ID : "";
                        let leadSource = dj.Lead ? "linked" : "";
                        if (!leadVal) {
                            const leadMatch = (dj.Description || "").match(/Lead\W*(?:no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                            if (leadMatch) { leadVal = leadMatch[1]; leadSource = "description"; }
                        }

                        // Quote Search
                        let quoteVal = dj.Quote ? dj.Quote.ID : "";
                        let quoteSource = dj.Quote ? "linked" : "";
                        if (!quoteVal) {
                            const quoteMatch = (dj.Description || "").match(/Quote\W*(?:no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                            if (quoteMatch) { quoteVal = quoteMatch[1]; quoteSource = "description"; }
                        }
                        
                        // Native Job Notes Search (Fallback)
                        if (!darnVal) {
                            const darnMatchNotes = (dj.Notes || "").match(/DARN\W*(?:form|no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                            if (darnMatchNotes) { darnVal = darnMatchNotes[1]; darnSource = "job_notes"; }
                        }
                        if (!leadVal) {
                            const leadMatchNotes = (dj.Notes || "").match(/Lead\W*(?:no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                            if (leadMatchNotes) { leadVal = leadMatchNotes[1]; leadSource = "job_notes"; }
                        }
                        if (!quoteVal) {
                            const quoteMatchNotes = (dj.Notes || "").match(/Quote\W*(?:no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                            if (quoteMatchNotes) { quoteVal = quoteMatchNotes[1]; quoteSource = "job_notes"; }
                        }
                        
                        // Communication Notes Search (Deep Fallback)
                        if (!darnVal || !leadVal || !quoteVal) {
                            try {
                                const notesRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${j.ID}/notes/`);
                                if (notesRes.data && notesRes.data.length > 0) {
                                    for (const n of notesRes.data) {
                                        if (!darnVal) {
                                            const m = (n.Note || "").match(/DARN\W*(?:form|no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                                            if (m) { darnVal = m[1]; darnSource = "comm_notes"; }
                                        }
                                        if (!leadVal) {
                                            const lm = (n.Note || "").match(/Lead\W*(?:no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                                            if (lm) { leadVal = lm[1]; leadSource = "comm_notes"; }
                                        }
                                        if (!quoteVal) {
                                            const qm = (n.Note || "").match(/Quote\W*(?:no|number|#|id)*\W*([A-Z0-9-]*\d+[A-Z0-9-]*)/i);
                                            if (qm) { quoteVal = qm[1]; quoteSource = "comm_notes"; }
                                        }
                                        if (darnVal && leadVal && quoteVal) break;
                                    }
                                }
                            } catch (e) {}
                        }

                        return {
                            Date: dj.DateIssued ? new Date(dj.DateIssued).toLocaleDateString('en-AU') : "",
                            EquipmentType: eqType,
                            Issue: descFormatted,
                            DisplayStatus: displayStatus,
                            Lead: leadVal ? `#${leadVal}` : "",
                            LeadSource: leadSource,
                            DARN: darnVal, 
                            DARNSource: darnSource,
                            Quote: quoteVal ? `#${quoteVal}` : "", 
                            QuoteSource: quoteSource,
                            Job: j.ID ? `#${j.ID}` : "", 
                            Comment: "",
                            Status: dj.Stage || "pending"
                        };
                    } catch (e) { return null; }
                }));
                outstandingWorks.push(...jobDetails.filter(d => d !== null));
            }

            const quotesRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/quotes/?Site.ID=${siteId}&pageSize=50`);
            if (quotesRes.data && quotesRes.data.length > 0) {
                for (const q of quotesRes.data) {
                    if (q.Stage) {
                        const qs = q.Stage.toLowerCase();
                        if (!qs.includes('pending')) {
                            continue;
                        }
                    }
                    
                    let qLead = q.Lead ? q.Lead.ID : "";
                    const qDesc = cleanDescriptionForClient(q.Description || "");
                    
                    outstandingWorks.push({
                        Date: q.DateIssued ? new Date(q.DateIssued).toLocaleDateString('en-AU') : "",
                        EquipmentType: "Quote/Work Needed",
                        Issue: qDesc,
                        DisplayStatus: "QUOTED",
                        Lead: qLead ? `#${qLead}` : "", 
                        DARN: "", 
                        Quote: q.ID ? `#${q.ID}` : "", 
                        Job: "", 
                        Comment: "", 
                        Status: q.Stage || "pending"
                    });
                }
            }
            // Sort by Status Hierarchy: 1. In Progress, 2. Pending, 3. Other
            outstandingWorks.sort((a, b) => {
                const getPriority = (status) => {
                    const s = (status || "").toLowerCase();
                    if (s.includes('progress')) return 1;
                    if (s.includes('pending')) return 2;
                    return 3;
                };
                return getPriority(a.Status) - getPriority(b.Status);
            });
        } catch (err) {
            console.error(`Aggregation error: ${err.message}`);
        }
    }

    return {
        JobID: parseInt(jobId), 
        Site: siteName,
        SiteContact: { Name: contactName || clientName, Phone: contactPhone, Email: contactEmail, Source: contactSource },
        Client: clientName, 
        DateCompleted: new Date().toLocaleDateString('en-AU'),
        DateCallMade: jobData.DateIssued ? new Date(jobData.DateIssued).toLocaleDateString('en-AU') : "Not Issued",
        AFSSDue: jobData.DateIssued ? new Date(new Date(jobData.DateIssued).setFullYear(new Date(jobData.DateIssued).getFullYear() + 1)).toLocaleDateString('en-AU') : "Check simPRO", 
        ServiceDue: {
            Type: (jobData.Name || "").toLowerCase().includes('12 monthly') ? "12 Monthly" : "6 Monthly",
            Month: new Date(jobData.DateIssued || new Date()).toLocaleString('default', { month: 'long' }),
            Year: new Date(jobData.DateIssued || new Date()).getFullYear()
        },
        OutstandingWorks: outstandingWorks
    };
};

/**
 * MCP Tool: get_fpow_data
 */
mcp.addTool({
    name: "get_fpow_data",
    description: "Fetch and aggregate FPOW data for a job ID, including site-wide outstanding works.",
    parameters: z.object({
        jobId: z.number().describe("The simPRO Job ID to retrieve data for")
    }),
    execute: async (args) => {
        return fetchFpowData(args.jobId);
    }
});

// Express App for UI and legacy API
const hApp = express();
hApp.use(express.json({ limit: '10mb' }));
hApp.use(express.static(__dirname));

// Serve index.html
hApp.get('/', (req, res) => {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    res.send(html);
});

hApp.get('/version.txt', (req, res) => {
    try {
        const v = fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf-8');
        res.send(v);
    } catch (e) { res.status(404).send("Version file not found"); }
});

// Legacy API Proxy
hApp.get('/api/job/:id', async (req, res) => {
    const jobId = parseInt(req.params.id);
    try {
        const result = await fetchFpowData(jobId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Schedules endpoint
hApp.get('/api/schedules/today', async (req, res) => {
    console.log(`[GET] /api/schedules/today`);
    try {
        const jobsRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/?pageSize=50&columns=ID,Name,Customer,DateIssued`);
        const schedules = jobsRes.data.map(job => ({
            jobId: job.ID,
            client: job.Customer?.CompanyName || job.Name || "simPRO Record",
            site: "simPRO Site", 
            time: job.DateIssued ? new Date(job.DateIssued).toLocaleDateString('en-AU') : "Live Record"
        }));
        res.json({ date: new Date().toISOString().split('T')[0], schedules });
    } catch (err) {
        res.json({ date: "Offline", schedules: [] });
    }
});

// Email endpoint
hApp.post('/api/send-email', async (req, res) => {
    try {
        const { jobId, recipientEmail, managerEmail, htmlContent, subject, clientName } = req.body;
        const payloadSize = JSON.stringify(req.body).length;
        console.log(`[POST] /api/send-email - Payload: ${Math.round(payloadSize/1024)}KB`);
        console.log(`[EMAIL] Job #${jobId} -> To: ${recipientEmail}, CC: ${managerEmail || MANAGER_EMAIL}`);

        const transporter = getTransporter();
        if (!transporter) {
            console.error('[SMTP ERROR] Transporter not initialized. Check SMTP_USER/PASS.');
            return res.status(500).json({ error: 'Email delivery not configured. Check server logs.' });
        }

        if (!recipientEmail && !managerEmail && !MANAGER_EMAIL) {
            console.warn('[EMAIL WARN] No recipient email addresses provided or found in env.');
            return res.status(400).json({ error: 'No recipient email addresses provided.' });
        }

        const recipients = [recipientEmail, (managerEmail && managerEmail.trim()) || MANAGER_EMAIL].filter(Boolean).join(',');

        // Check logo exists before attaching
        const logoPath = path.join(__dirname, 'logo.png');
        const attachments = [];
        if (fs.existsSync(logoPath)) {
            attachments.push({ filename: 'logo.png', path: logoPath, cid: 'redmen-logo' });
        } else {
            console.warn('[EMAIL] logo.png not found, sending without logo attachment.');
        }

        const mailOptions = {
            from: `"FPOWS Automation" <${SMTP_USER}>`,
            to: recipients,
            subject: subject || `FPOWS Call Sheet - Job #${jobId} - ${clientName || 'Unknown Client'}`,
            html: htmlContent,
            attachments
        };

        await sendMailWithRetry(transporter, mailOptions, 1);
        
        // Structured Log Entry
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: "EMAIL_SUCCESS",
            jobId,
            client: clientName || "Unknown Client",
            clientEmail: recipientEmail || "—",
            managerEmail: (managerEmail && managerEmail.trim()) || MANAGER_EMAIL || "—",
            subject: mailOptions.subject
        };
        
        console.log(`[EMAIL SUCCESS] Job #${jobId} -> ${recipients}`);
        const logPath = path.join(__dirname, 'email_history.jsonl');
        fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
        
        res.json({ success: true, sentTo: recipients });
    } catch (err) {
        console.error(`[EMAIL ERROR] ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Logs endpoint for manager
hApp.get('/api/logs', (req, res) => {
    try {
        const logPath = path.join(__dirname, 'email_history.jsonl');
        if (!fs.existsSync(logPath)) return res.json({ logs: [] });
        
        const raw = fs.readFileSync(logPath, 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean);
        
        const logs = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) { return null; }
        }).filter(Boolean).reverse().slice(0, 50); 
        
        res.json({ logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete history endpoint
hApp.post('/api/delete-history', (req, res) => {
    try {
        const { timestamp } = req.body;
        if (!timestamp) return res.status(400).json({ error: 'Timestamp is required' });

        const historyPath = path.join(__dirname, 'email_history.jsonl');
        if (!fs.existsSync(historyPath)) return res.json({ success: true });

        const historyLines = fs.readFileSync(historyPath, 'utf8').split('\n');
        const updatedLines = historyLines.filter(line => {
            if (!line.trim()) return false;
            try {
                const item = JSON.parse(line);
                return item.timestamp !== timestamp;
            } catch(e) { return true; } // Keep corrupted lines or handle them
        });

        fs.writeFileSync(historyPath, updatedLines.join('\n') + (updatedLines.length > 0 ? '\n' : ''));
        res.json({ success: true });
    } catch (err) {
        console.error("Delete history error:", err);
        res.status(500).json({ error: err.message });
    }
});


// Start Server (Express Listener for Cloud Run)
hApp.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] FPOWS Automation live on port ${PORT}`);
});
