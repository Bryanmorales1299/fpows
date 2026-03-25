import { FastMCP } from 'fastmcp';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import dotenv from 'dotenv';
import { z } from 'zod';
import nodemailer from 'nodemailer';

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

const getSimpro = async (path) => {
    if (!SIMPRO_BASE_URL) throw new Error("SIMPRO_BASE_URL not configured");
    const rawUrl = `${SIMPRO_BASE_URL.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
    try {
        const validatedUrl = new URL(rawUrl).toString();
        return axios.get(validatedUrl, {
            headers: {
                'Authorization': `Bearer ${SIMPRO_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 15000 
        });
    } catch (urlErr) {
        throw new Error(`Invalid URL: ${rawUrl}`);
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
    const desc = jobData.Description || "";
    const nameMatch = desc.match(/Name:\s*([^<\n\r]+)/i);
    const phoneMatch = desc.match(/Phone[^:]*:\s*([^<\n\r]+)/i);
    const emailMatch = desc.match(/Email:\s*([^<\n\r]+)/i);

    let contactName = jobData.Contact?.Name || (nameMatch ? nameMatch[1].trim() : "");
    let contactPhone = jobData.Contact?.Phone || (phoneMatch ? phoneMatch[1].trim() : "");
    let contactEmail = jobData.Contact?.Email || (emailMatch ? emailMatch[1].trim() : "");

    if (!contactName && jobData.Site?.ID) {
        try {
            const scRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/sites/${jobData.Site.ID}/contacts/`);
            if (scRes.data && scRes.data.length > 0) {
                contactName = `${scRes.data[0].GivenName || ''} ${scRes.data[0].FamilyName || ''}`.trim();
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
            const jobsRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/?SiteID=${siteId}&Stage=Progress&pageSize=50`);
            if (jobsRes.data && jobsRes.data.length > 0) {
                const jobDetails = await Promise.all(jobsRes.data.map(async (j) => {
                    try {
                        const detailRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${j.ID}`);
                        const dj = detailRes.data;
                        const descStrip = (dj.Description || "").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        
                        let sq = "";
                        const qRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/quotes/?JobID=${j.ID}`);
                        if (qRes.data && qRes.data.length > 0) sq = qRes.data[0].ID;

                        // Robust Equipment Type Lookup
                        let eqType = "";
                        try {
                            const secRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${j.ID}/sections/`);
                            if (secRes.data && secRes.data.length > 0) {
                                for (const section of secRes.data) {
                                    const ccRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${j.ID}/sections/${section.ID}/costCenters/`);
                                    if (ccRes.data && ccRes.data.length > 0) {
                                        for (const cc of ccRes.data) {
                                            const rawName = cc.Name || cc.CostCenter?.Name || "";
                                            if (rawName && !rawName.toLowerCase().includes("general")) {
                                                eqType = rawName; break;
                                            }
                                        }
                                    }
                                    if (eqType) break;
                                }
                            }
                        } catch (e) {}

                        if (!eqType || eqType.toLowerCase().includes("general")) {
                            eqType = dj.Name || "Service Job";
                        }

                        // DARN Search
                        let darnVal = "";
                        const darnMatch = (dj.Description || "").match(/DARN[:#\s\.]*([A-Z0-9-]+)/i);
                        if (darnMatch) darnVal = darnMatch[1];
                        if (!darnVal) {
                            try {
                                const notesRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/${j.ID}/notes/`);
                                if (notesRes.data) {
                                    for (const n of notesRes.data) {
                                        const m = (n.Note || "").match(/DARN[:#\s\.]*([A-Z0-9-]+)/i);
                                        if (m) { darnVal = m[1]; break; }
                                    }
                                }
                            } catch (e) {}
                        }

                        return {
                            Date: dj.DateIssued ? new Date(dj.DateIssued).toLocaleDateString('en-AU') : "",
                            EquipmentType: eqType,
                            Issue: descStrip,
                            DARN: darnVal, 
                            Quote: sq ? `#${sq}` : "", 
                            Job: j.ID ? `#${j.ID}` : "", 
                            Comment: "",
                            Status: dj.Stage || "pending"
                        };
                    } catch (e) { return null; }
                }));
                outstandingWorks.push(...jobDetails.filter(d => d !== null));
            }

            const quotesRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/quotes/?SiteID=${siteId}&Stage=Pending&pageSize=50`);
            if (quotesRes.data && quotesRes.data.length > 0) {
                for (const q of quotesRes.data) {
                    outstandingWorks.push({
                        Date: q.DateIssued ? new Date(q.DateIssued).toLocaleDateString('en-AU') : "",
                        EquipmentType: "Quote/Work Needed",
                        Issue: (q.Description || "").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                        DARN: "", Quote: q.ID ? `#${q.ID}` : "", Job: "", Comment: "", Status: q.Stage || "pending"
                    });
                }
            }
        } catch (err) {
            console.error(`Aggregation error: ${err.message}`);
        }
    }

    return {
        JobID: parseInt(jobId), 
        Site: siteName,
        SiteContact: { Name: contactName || clientName, Phone: contactPhone, Email: contactEmail },
        Client: clientName, 
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
import express from 'express';
const hApp = express();
hApp.use(express.json());

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

        if (!SMTP_USER || !SMTP_PASS) {
            return res.status(500).json({ error: 'Email not configured. Set SMTP_USER and SMTP_PASS in environment.' });
        }

        if (!recipientEmail && !managerEmail) {
            return res.status(400).json({ error: 'No recipient email addresses provided.' });
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: SMTP_USER, pass: SMTP_PASS }
        });

        const recipients = [recipientEmail, (managerEmail && managerEmail.trim()) || MANAGER_EMAIL].filter(Boolean).join(',');

        const mailOptions = {
            from: `"FPOWS Automation" <${SMTP_USER}>`,
            to: recipients,
            subject: subject || `FPOWS Call Sheet - Job #${jobId} - ${clientName || 'Unknown Client'}`,
            html: htmlContent
        };

        await transporter.sendMail(mailOptions);
        
        // Structured Log Entry
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: "EMAIL_SUCCESS",
            jobId,
            client: clientName || "Unknown Client",
            to: recipients,
            subject: mailOptions.subject
        };
        
        console.log(`[EMAIL SUCCESS] Job #${jobId} -> ${recipients}`);
        const logPath = '/tmp/email_history.jsonl';
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
        const logPath = '/tmp/email_history.jsonl';
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

// Start Server (Express Listener for Cloud Run)
hApp.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] FPOWS Automation live on port ${PORT}`);
});
