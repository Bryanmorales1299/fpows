import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import dotenv from 'dotenv';

// Only load .env if not in production to avoid shadowing Cloud Run vars
if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// Utility to aggressively clean environment variables from hidden characters or quotes
const cleanEnv = (val, defaultValue = "") => {
    if (!val || val === "undefined" || val === "null" || val === "") return defaultValue;
    // Remove all non-printable/hidden characters, then trim and remove quotes
    return val.toString().replace(/[^\x20-\x7E]/g, '').trim().replace(/^"|"$/g, '');
};

// SimPRO credentials
const SIMPRO_BASE_URL = cleanEnv(process.env.SIMPRO_BASE_URL, "https://redmen-uat.simprosuite.com").replace(/\/$/, '');
const SIMPRO_ACCESS_TOKEN = cleanEnv(process.env.SIMPRO_ACCESS_TOKEN, "6c6b91755ff14c8ff1ffb843c0737955d7a3a88a");

// We'll use absolute URLs instead of baseURL to avoid Axios configuration issues in some environments
const getSimpro = async (path) => {
    const rawUrl = `${SIMPRO_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
    try {
        const validatedUrl = new URL(rawUrl).toString();
        return axios.get(validatedUrl, {
            headers: {
                'Authorization': `Bearer ${SIMPRO_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 10000 
        });
    } catch (urlErr) {
        console.error(`[CRITICAL] Invalid URL constructed: <${rawUrl}> - ${urlErr.message}`);
        throw new Error(`Invalid URL: ${rawUrl}`);
    }
};

// Mock MCP tool behavior via REST API for FPOWS data
app.get('/api/job/:id', async (req, res) => {
    const jobId = req.params.id;
    try {
        const jobRes = await getSimpro(`/api/v1.0/companies/1/jobs/${jobId}`);
        const jobData = jobRes.data;
        // Harden Site ID and Name detection
        const siteId = jobData.Site?.ID || jobData.Site?.id || jobData.SiteID || jobData.siteID || (typeof jobData.Site === 'number' ? jobData.Site : (jobData.Site?.includes ? parseInt(jobData.Site) : null));
        // 1. Site Info
        let siteName = jobData.Site?.Name || jobData.Site?.name || (typeof jobData.Site === 'string' ? jobData.Site : "Unknown Site");
        
        // 2. Contact Parse from Description
        const desc = jobData.Description || "";
        const nameMatch = desc.match(/Name:\s*([^<\n\r]+)/i);
        const phoneMatch = desc.match(/Phone[^:]*:\s*([^<\n\r]+)/i);
        const emailMatch = desc.match(/Email:\s*([^<\n\r]+)/i);

        let contactName = jobData.Contact?.Name || (nameMatch ? nameMatch[1].trim() : "");
        let contactPhone = jobData.Contact?.Phone || (phoneMatch ? phoneMatch[1].trim() : "");
        let contactEmail = jobData.Contact?.Email || (emailMatch ? emailMatch[1].trim() : "");

        if (!contactName && siteId) {
            try {
                const scRes = await getSimpro(`/api/v1.0/companies/1/sites/${siteId}/contacts/`);
                if (scRes.data && scRes.data.length > 0) {
                    contactName = `${scRes.data[0].GivenName || ''} ${scRes.data[0].FamilyName || ''}`.trim();
                }
            } catch (e) {}
        }

        // 3. Customer Info
        let clientName = jobData.Customer?.CompanyName || jobData.Customer?.Name || "Unknown Client";
        if (jobData.Customer?.ID) {
            try {
                const custRes = await getSimpro(`/api/v1.0/companies/1/customers/${jobData.Customer.ID}`);
                const cust = custRes.data;
                clientName = cust.CompanyName || `${cust.GivenName || ''} ${cust.FamilyName || ''}`.trim() || clientName;
            } catch (e) {}
        }

        // 4. Grouped Issues & Service Milestones
        const allWorks = [];
        const seenIssues = new Set();
        let sixMonthlyJob = null;
        let twelveMonthlyJob = null;
        
        const processJob = async (job, isPrimary = false) => {
            const sjId = job.ID || job.id;
            if (!sjId || seenIssues.has(sjId)) return;
            seenIssues.add(sjId);

            try {
                const sjDescRaw = (job.Description || "");
                const sjDesc = sjDescRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                const sjName = job.Name || "";
                
                const rawDate = job.DateIssued || job.DateCreated || job.DateCompleted;
                const formattedDate = rawDate ? new Date(rawDate).toLocaleDateString('en-AU') : "—";
                const leadId = job.Lead?.ID || job.LeadID || "—";

                const qMatchRes = sjDesc.match(/(?:Quote|Quote Number|Quote\s*#|Quote\s*:)[^0-9]{0,15}(\d{4,})/i);
                const dMatchRes = sjDesc.match(/(?:DARN|DARN\s*#|DARN\s*NO|DARN\s*:)[^0-9]{0,15}(\d{4,})/i);
                let extractedQuote = qMatchRes ? qMatchRes[1] : (job.Quote?.ID || "—");
                let extractedDarn = dMatchRes ? dMatchRes[1] : "—";

                const rawStatusFull = job.Status?.Name || (typeof job.Status === 'string' ? job.Status : null) || job.Stage || "pending";
                const rawStatus = rawStatusFull.toLowerCase();

                // Scan for service dates while processing site jobs
                const sjNameLower = (job.Name || "").toLowerCase();
                const sjDate = new Date(job.DateIssued || job.DateCreated);
                if (sjNameLower.includes('6 monthly')) {
                    if (!sixMonthlyJob || sjDate > new Date(sixMonthlyJob.DateIssued || sixMonthlyJob.DateCreated)) sixMonthlyJob = job;
                }
                if (sjNameLower.includes('12 monthly') || sjNameLower.includes('annual')) {
                    if (!twelveMonthlyJob || sjDate > new Date(twelveMonthlyJob.DateIssued || twelveMonthlyJob.DateCreated)) twelveMonthlyJob = job;
                }

                let issueDisplay = sjName || "Job Record";
                
                // PERFORMANCE: ONLY fetch subsections for the PRIMARY job to avoid timeouts on large sites
                if (isPrimary || sjName.length <= 4) {
                    try {
                        const sRes = await getSimpro(`/api/v1.0/companies/1/jobs/${sjId}/sections/`);
                        if (sRes.data && sRes.data.length > 0) {
                            const ccRes = await getSimpro(`/api/v1.0/companies/1/jobs/${sjId}/sections/${sRes.data[0].ID}/costCenters/`);
                            if (ccRes.data && ccRes.data.length > 0) {
                                const ccName = ccRes.data[0].Name;
                                if (ccName && ccName.length > 4) issueDisplay = ccName;
                                else {
                                    const scopeMatch = sjDesc.match(/(?:SCOPE OF WORKS|Works:|Action Required:)\s*(.*)/i);
                                    if (scopeMatch) issueDisplay = scopeMatch[1].substring(0, 500).trim();
                                    else issueDisplay = sjDesc.substring(0, 500) || ccName || sjName;
                                }
                            }
                        }
                    } catch (e) {}
                }

                allWorks.push({
                    Date: formattedDate,
                    EquipmentType: (sjName + sjDesc).toLowerCase().includes('fire') ? "Fire Protection" : "General Maintenance",
                    Issue: issueDisplay,
                    DARN: extractedDarn,
                    Quote: extractedQuote,
                    Job: sjId,
                    Responsibility: leadId !== "—" ? `Lead ${leadId}` : "",
                    Comment: sjDesc.substring(0, 1000), 
                    Status: rawStatusFull 
                });
            } catch (err) {
                console.error(`Error processing job ${sjId}:`, err.message);
            }
        };

        // 1. Process primary job
        await processJob(jobData, true);

        if (siteId) {
            try {
                // Adding Description to columns set (testing stability for Harris Park #420430)
                const siteJobPath = `/api/v1.0/companies/1/jobs/?SiteID=${siteId}&pageSize=100&columns=ID,Name,Description,DateIssued,Status`;
                const siteJobsRes = await getSimpro(siteJobPath);
                const allSiteJobs = siteJobsRes.data || [];
                
                for (const sj of allSiteJobs) {
                    await processJob(sj, false);
                }

                // 3. Fetch all quotes for this site
                const siteQuotesRes = await getSimpro(`/api/v1.0/companies/1/quotes/?SiteID=${siteId}&Status=open&pageSize=50`);
                for (const sq of siteQuotesRes.data || []) {
                    if (sq.JobID) continue; 
                    const sqDesc = (sq.Description || "").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    if (!sqDesc || seenIssues.has(`q-${sq.ID}`)) continue;
                    seenIssues.add(`q-${sq.ID}`);
                    allWorks.push({
                        Date: sq.DateIssued ? new Date(sq.DateIssued).toLocaleDateString('en-AU') : "Check simPRO",
                        EquipmentType: "Quote Recommendation",
                        Issue: sqDesc.substring(0, 500),
                        DARN: "—", Quote: sq.ID, Job: "—", Responsibility: "Pending Approval", Comment: "Open Quote",
                        Status: "pending"
                    });
                }
            } catch (e) {
                console.error("Error fetching site-wide data:", e.message);
            }
        }
        
        // Performance Note: Site history is now fast because we skip nested API calls for historical records
        return res.json({
            JobID: jobId, Site: siteName,
            SiteContact: { Name: contactName || clientName, Phone: contactPhone, Email: contactEmail },
            Client: clientName, 
            DateCallMade: jobData.DateIssued ? new Date(jobData.DateIssued).toLocaleDateString('en-AU') : "Not Issued",
            DateCompleted: jobData.CompletedDate ? new Date(jobData.CompletedDate).toLocaleDateString('en-AU') : "Pending",
            AFSSDue: "Check simPRO",
            ServiceDue: {
                SixMonthly: sixMonthlyJob ? {
                    Month: new Date(sixMonthlyJob.DateIssued || sixMonthlyJob.DateCreated).toLocaleString('default', { month: 'long' }),
                    Year: new Date(sixMonthlyJob.DateIssued || sixMonthlyJob.DateCreated).getFullYear()
                } : null,
                TwelveMonthly: twelveMonthlyJob ? {
                    Month: new Date(twelveMonthlyJob.DateIssued || twelveMonthlyJob.DateCreated).toLocaleString('default', { month: 'long' }),
                    Year: new Date(twelveMonthlyJob.DateIssued || twelveMonthlyJob.DateCreated).getFullYear()
                } : null
            },
            OutstandingWorks: allWorks
        });
    } catch (err) {
        const errorMsg = err.response?.data?.errors?.[0]?.message || err.message;
        const failedUrl = err.config?.url || "Unknown URL";
        console.error(`[ERROR] Fetch failed for ${failedUrl}: ${errorMsg}`);
        res.status(500).json({ error: `SIMPRO API ERROR [${failedUrl}]: ${errorMsg}` });
    }
});

app.get('/api/schedules/today', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const jobsRes = await getSimpro('/api/v1.0/companies/1/jobs/?pageSize=50&columns=ID,Name,Customer,DateIssued');
        
        let schedules = jobsRes.data.map(job => {
            let formattedDate = "";
            if (job.DateIssued) {
                const dateObj = new Date(job.DateIssued);
                const day = dateObj.getDate();
                const mon = dateObj.toLocaleString('default', { month: 'short' });
                const year = dateObj.getFullYear();
                formattedDate = `${day} ${mon} ${year}`;
            }

            return {
                jobId: job.ID,
                client: job.Customer ? (job.Customer.CompanyName || `${job.Customer.GivenName || ''} ${job.Customer.FamilyName || ''}`.trim() || job.Name) : job.Name || "SimPRO Job",
                site: "simPRO Site", 
                time: formattedDate || "Recent"
            };
        });
        
        if (schedules.length === 0) {
            schedules = [
                { jobId: 423242, client: "Jonny Macleod Retirement Village", site: "48 Victory Parade Wallsond", time: "Recent" }
            ];
        }
        res.json({ date: today, schedules });
    } catch (err) {
        console.error("Error fetching jobs for dropdown:", err.message);
        res.json({ date: "Offline", schedules: [
            { jobId: 423242, client: "Offline Demo: Jonny Macleod Village", site: "Offline Site", time: "Recent" }
        ]});
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`FPOWS sheet interface: http://localhost:${PORT}/index.html`);
});
