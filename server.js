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

/**
 * Background Service: Sync Asset Service Dates back to simPRO
 * This ensures that when a job is processed, the next service date is automatically set in the DB.
 */
async function syncAssetDates(siteId, jobDate, jobType) {
    if (!siteId) return;
    
    try {
        console.log(`[AUTO-SYNC] Starting asset sync for Site #${siteId} (Type: ${jobType}, Date: ${jobDate})`);
        
        // 1. Calculate the Target Next Date
        const baseDate = new Date(jobDate);
        if (isNaN(baseDate.getTime())) return;
        
        // Move to the same day next cycle
        if (jobType === "12 Monthly") {
            baseDate.setFullYear(baseDate.getFullYear() + 1);
        } else {
            baseDate.setMonth(baseDate.getMonth() + 6);
        }
        
        // Format to YYYY-MM-DD for simPRO
        const nextDateStr = baseDate.toISOString().split('T')[0];
        console.log(`[AUTO-SYNC] Target Next Date: ${nextDateStr}`);

        // 2. Fetch Assets for this Site
        const assetsRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/sites/${siteId}/assets/`);
        if (!assetsRes.data || assetsRes.data.length === 0) return;

        for (const asset of assetsRes.data) {
            try {
                // 3. Fetch Service Levels for each asset
                const slRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/assets/${asset.ID}/serviceLevels/`);
                if (!slRes.data) continue;

                for (const sl of slRes.data) {
                    const slName = (sl.Name || "").toLowerCase();
                    const isAnnualMatch = jobType === "12 Monthly" && (slName.includes("annual") || slName.includes("12 month"));
                    const is6MonthMatch = jobType === "6 Monthly" && (slName.includes("6 month"));

                    if (isAnnualMatch || is6MonthMatch) {
                        // 4. Update if the date is different (Safety check: also ensuring we don't move backwards)
                        if (sl.NextDate !== nextDateStr) {
                            console.log(`[AUTO-SYNC] Updating Asset #${asset.ID} Service Level #${sl.ID} to ${nextDateStr}`);
                            await axios.patch(`${process.env.SIMPRO_BASE_URL}/api/v1.0/companies/${COMPANY_ID}/assets/${asset.ID}/serviceLevels/${sl.ID}/`, 
                                { NextDate: nextDateStr },
                                { headers: { 'Authorization': `Bearer ${process.env.SIMPRO_ACCESS_TOKEN}` } }
                            );
                        }
                    }
                }
            } catch (e) {
                console.error(`[AUTO-SYNC ERROR] Failed asset #${asset.ID}: ${e.message}`);
            }
        }
        console.log(`[AUTO-SYNC] Completed for Site #${siteId}`);
    } catch (err) {
        console.error(`[AUTO-SYNC CRITICAL ERROR]: ${err.message}`);
    }
}

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

    // 4. Site-Wide Aggregation (Filtered by Customer to prevent cross-account confusion)
    const siteId = jobData.Site ? jobData.Site.ID : null;
    const customerId = jobData.Customer ? jobData.Customer.ID : null;
    const outstandingWorks = [];

    if (siteId) {
        try {
            let siteJobsUrl = `/api/v1.0/companies/${COMPANY_ID}/jobs/?Site.ID=${siteId}&pageSize=50`;
            if (customerId) siteJobsUrl += `&Customer.ID=${customerId}`;
            
            const jobsRes = await getSimpro(siteJobsUrl);
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
                            Status: displayStatus // Use our distilled DisplayStatus for sorting consistency
                        };
                    } catch (e) { return null; }
                }));
                outstandingWorks.push(...jobDetails.filter(d => d !== null));
            }

            let siteQuotesUrl = `/api/v1.0/companies/${COMPANY_ID}/quotes/?Site.ID=${siteId}&pageSize=50`;
            if (customerId) siteQuotesUrl += `&Customer.ID=${customerId}`;

            const quotesRes = await getSimpro(siteQuotesUrl);
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
                        Status: "QUOTED" // Distinct status for quotes
                    });
                }
            }
            // Sort by Status Hierarchy: 1. IN PROGRESS, 2. PENDING, 3. QUOTED, 4. Others
            outstandingWorks.sort((a, b) => {
                const getPriority = (status) => {
                    const s = (status || "").toLowerCase();
                    if (s === 'in progress') return 1;
                    if (s === 'pending') return 2;
                    if (s === 'quoted') return 3;
                    return 4;
                };
                
                const pA = getPriority(a.Status);
                const pB = getPriority(b.Status);
                
                if (pA !== pB) return pA - pB;
                
                // Secondary sort: Newest Job/Quote ID first
                const idA = parseInt((a.Job || a.Quote || "0").replace(/\D/g, ''));
                const idB = parseInt((b.Job || b.Quote || "0").replace(/\D/g, ''));
                return idB - idA;
            });
        } catch (err) {
            console.error(`Aggregation error: ${err.message}`);
        }
    }

    // --- Dynamic Asset Date Discovery (NEW SOURCE OF TRUTH) ---
    // Uses the /customerAssets/ endpoint which returns ServiceLevels INLINE (single API call).
    // The /assets/{id}/serviceLevels/ endpoint does NOT exist on LIVE simPRO.
    let liveSixMo = { Month: "", Year: "" };
    let liveTwelveMo = { Month: "", Year: "" };

    if (siteId) {
        try {
            console.log(`[ASSET DISCOVERY] Fetching Customer Assets for Site #${siteId}...`);
            const custAssetsRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/customerAssets/?Site.ID=${siteId}&pageSize=50`);
            
            if (custAssetsRes.data && custAssetsRes.data.length > 0) {
                console.log(`[ASSET DISCOVERY] Found ${custAssetsRes.data.length} customer assets at site.`);
                
                for (const asset of custAssetsRes.data) {
                    if (!asset.ServiceLevels || asset.ServiceLevels.length === 0) continue;
                    
                    for (const sl of asset.ServiceLevels) {
                        // Use ServiceDate (the field returned by customerAssets endpoint)
                        const dateStr = sl.ServiceDate || sl.NextDate || "";
                        if (!dateStr) continue;
                        
                        const slName = (sl.Name || "").toLowerCase();
                        const slDate = new Date(dateStr);
                        if (isNaN(slDate.getTime())) continue;
                        
                        const monthStr = slDate.toLocaleString('default', { month: 'long' });
                        const yearNum = slDate.getFullYear().toString();

                        // 12-Month / Annual Matching
                        const isAnnual = slName.includes("annual") || slName.includes("12 month") || slName.includes("yearly") || slName.includes("contract") || slName.includes("12month");
                        // 6-Month matching
                        const is6Mo = slName.includes("6 month") || slName.includes("6month") || slName.includes("bi-annual") || slName.includes("half year") || slName.includes("semi-annual");
                        
                        if (isAnnual && !liveTwelveMo.Month) {
                            console.log(`[ASSET MATCH] Found Annual: ${monthStr} ${yearNum} on Asset #${asset.ID} (${sl.Name})`);
                            liveTwelveMo = { Month: monthStr, Year: yearNum };
                        } else if (is6Mo && !liveSixMo.Month) {
                            console.log(`[ASSET MATCH] Found 6-Mo: ${monthStr} ${yearNum} on Asset #${asset.ID} (${sl.Name})`);
                            liveSixMo = { Month: monthStr, Year: yearNum };
                        }
                    }
                    if (liveTwelveMo.Month && liveSixMo.Month) break;
                }
            } else {
                console.log(`[ASSET DISCOVERY] No customer assets found for site #${siteId}`);
            }
        } catch (e) {
            console.error(`[ASSET DISCOVERY ERROR] Site #${siteId}: ${e.message}`);
        }
    }

    const result = {
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
            Year: new Date(jobData.DateIssued || new Date()).getFullYear(),
            // Pass live data for BOTH display sections
            LiveSixMo: liveSixMo,
            LiveTwelveMo: liveTwelveMo
        },
        OutstandingWorks: outstandingWorks
    };

    // 5. Initiate Background Asset Sync (Do not await, keep it fast for the user)
    const jobType = result.ServiceDue.Type;
    if (jobData.DateIssued && siteId) {
        syncAssetDates(siteId, jobData.DateIssued, jobType).catch(e => console.error("AutoSync catch:", e));
    }

    return result;
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

let activeCustomersCache = null;
let activeCustomersCacheTime = 0;

// Customer Search endpoint
hApp.get('/api/customers/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length > 0 && q.length < 2) return res.json({ results: [] });
    console.log(`[GET] /api/customers/search?q=${q}`);
    try {
        // Cache valid for 60 seconds to prevent hammering simPRO API
        if (!activeCustomersCache || (Date.now() - activeCustomersCacheTime) > 60000) {
            console.log(`[SIMPRO API] Refreshing Active Customers Cache via Jobs endpoint...`);
            
            // 1. Fetch recent Pending and InProgress jobs (Increased limit to 250)
            const pendingRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/?Stage=Pending&pageSize=250&orderby=-ID&columns=Customer`);
            const inProgRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/?Stage=Progress&pageSize=250&orderby=-ID&columns=Customer`);
            
            const allActiveJobs = [...(pendingRes.data || []), ...(inProgRes.data || [])];
            
            // 2. Extract unique Customers from those active jobs
            const uniqueMap = new Map();
            allActiveJobs.forEach(job => {
                if (job.Customer && job.Customer.ID) {
                    uniqueMap.set(job.Customer.ID, {
                        id: String(job.Customer.ID),
                        name: job.Customer.CompanyName || 'Unnamed',
                        type: 'Company'
                    });
                }
            });
            activeCustomersCache = Array.from(uniqueMap.values());
            activeCustomersCacheTime = Date.now();
        }
        
        // 3. Perform Case-Insensitive Name Search
        let filtered = activeCustomersCache;
        if (q.length >= 2) {
            const lowerQ = q.toLowerCase();
            filtered = activeCustomersCache.filter(c => c.name.toLowerCase().includes(lowerQ));
        }

        // 4. Arrange: Ensure the list is sorted by Job ID (Latest activity first)
        const results = filtered.sort((a, b) => parseInt(b.id) - parseInt(a.id)).slice(0, 50);
        res.json({ results });
    } catch (err) {
        console.error(`[CUSTOMER SEARCH ERROR] ${err.message}`);
        res.json({ results: [], error: err.message });
    }
});

// Customer Jobs endpoint (get jobs for a specific customer)
hApp.get('/api/customers/:id/jobs', async (req, res) => {
    const custId = req.params.id;
    console.log(`[GET] /api/customers/${custId}/jobs`);
    try {
        const jobsRes = await getSimpro(`/api/v1.0/companies/${COMPANY_ID}/jobs/?Customer.ID=${custId}&pageSize=30&orderby=-ID&columns=ID,Name,Site,Stage,DateIssued`);
        
        const validStages = ['Pending', 'Progress'];
        const jobs = (jobsRes.data || [])
            .filter(j => validStages.includes(j.Stage))
            .map(j => ({
                id: j.ID,
                name: j.Name || `Job #${j.ID}`,
                site: j.Site?.Name || 'Unknown Site',
                stage: j.Stage === 'Progress' ? 'In Progress' : j.Stage,
                date: j.DateIssued ? new Date(j.DateIssued).toLocaleDateString('en-AU') : '—',
                rawDate: j.DateIssued || '0'
            }))
            .sort((a, b) => {
                // 1. Priority to "In Progress"
                if (a.stage === 'In Progress' && b.stage !== 'In Progress') return -1;
                if (b.stage === 'In Progress' && a.stage !== 'In Progress') return 1;
                
                // 2. Latest date/ID first
                return parseInt(b.id) - parseInt(a.id);
            });
            
        res.json({ jobs });
    } catch (err) {
        console.error(`[CUSTOMER JOBS ERROR] ${err.message}`);
        res.json({ jobs: [], error: err.message });
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
