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
console.log(`[DEBUG] Raw process.env.SIMPRO_BASE_URL: ${JSON.stringify(process.env.SIMPRO_BASE_URL)}`);
const SIMPRO_BASE_URL = cleanEnv(process.env.SIMPRO_BASE_URL, "https://redmen-uat.simprosuite.com").replace(/\/$/, '');
const SIMPRO_ACCESS_TOKEN = cleanEnv(process.env.SIMPRO_ACCESS_TOKEN, "6c6b91755ff14c8ff1ffb843c0737955d7a3a88a");

console.log(`[INIT] SimPRO connectivity initialized for: ${JSON.stringify(SIMPRO_BASE_URL)}`);

// We'll use absolute URLs instead of baseURL to avoid Axios configuration issues in some environments
const getSimpro = async (path) => {
    const rawUrl = `${SIMPRO_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
    try {
        const validatedUrl = new URL(rawUrl).toString();
        console.log(`[FETCHING] ${JSON.stringify(validatedUrl)}`);
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

        // 1. Site Info
        let siteName = jobData.Site?.Name || "Unknown Site";
        
        // 2. Contact Parse from Description
        const desc = jobData.Description || "";
        const nameMatch = desc.match(/Name:\s*([^<\n\r]+)/i);
        const phoneMatch = desc.match(/Phone[^:]*:\s*([^<\n\r]+)/i);
        const emailMatch = desc.match(/Email:\s*([^<\n\r]+)/i);

        let contactName = jobData.Contact?.Name || (nameMatch ? nameMatch[1].trim() : "");
        let contactPhone = jobData.Contact?.Phone || (phoneMatch ? phoneMatch[1].trim() : "");
        let contactEmail = jobData.Contact?.Email || (emailMatch ? emailMatch[1].trim() : "");

        if (!contactName && jobData.Site?.ID) {
            try {
                const scRes = await getSimpro(`/api/v1.0/companies/1/sites/${jobData.Site.ID}/contacts/`);
                if (scRes.data && scRes.data.length > 0) {
                    contactName = `${scRes.data[0].GivenName || ''} ${scRes.data[0].FamilyName || ''}`.trim();
                }
            } catch (e) {}
        }

        // 4. Customer Info
        let clientName = jobData.Customer?.CompanyName || jobData.Customer?.Name || "Unknown Client";
        let realPhone = "";
        let realEmail = "";

        if (jobData.Customer?.ID) {
            try {
                const custRes = await getSimpro(`/api/v1.0/companies/1/customers/${jobData.Customer.ID}`);
                const cust = custRes.data;
                clientName = cust.CompanyName || `${cust.GivenName || ''} ${cust.FamilyName || ''}`.trim() || clientName;
                if (!contactPhone) realPhone = cust.Phone || cust.AltPhone || "";
                if (!contactEmail) realEmail = cust.Email || "";
            } catch (e) {}
        }

        // 5. Formatting
        const dateIssued = jobData.DateIssued ? new Date(jobData.DateIssued).toLocaleDateString('en-AU') : "Not Issued";
        const dateCompleted = jobData.CompletedDate ? new Date(jobData.CompletedDate).toLocaleDateString('en-AU') : "Pending";
        const afssDate = jobData.DateIssued ? new Date(new Date(jobData.DateIssued).setFullYear(new Date(jobData.DateIssued).getFullYear() + 1)).toLocaleDateString('en-AU') : "Check simPRO";
        const descriptionStrip = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        let quoteNumber = "";
        try {
            const quoteRes = await getSimpro(`/api/v1.0/companies/1/quotes/?JobID=${jobId}`);
            if (quoteRes.data && quoteRes.data.length > 0) quoteNumber = quoteRes.data[0].ID;
        } catch (e) {}

        const formattedData = {
            JobID: jobId, Site: siteName,
            SiteContact: { Name: contactName || clientName, Phone: contactPhone || realPhone, Email: contactEmail || realEmail },
            Client: clientName, DateCallMade: dateIssued, DateCompleted: dateCompleted, AFSSDue: afssDate, 
            ServiceDue: {
                Type: (jobData.Name || "").toLowerCase().includes('12 monthly') ? "12 Monthly" : "6 Monthly",
                Month: new Date(jobData.DateIssued || new Date()).toLocaleString('default', { month: 'long' }),
                Year: new Date(jobData.DateIssued || new Date()).getFullYear()
            },
            OutstandingWorks: []
        };

        if (descriptionStrip) {
            formattedData.OutstandingWorks.push({
                Date: dateIssued, EquipmentType: "General Maintenance",
                Issue: descriptionStrip.substring(0, 150) + (descriptionStrip.length > 150 ? '...' : ''),
                DARN: "", Quote: quoteNumber || "", Job: jobId, Responsibility: "", Comment: "Imported from Description",
                Status: jobData.Stage || "pending"
            });
        }
        
        res.json(formattedData);
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
        const jobsRes = await getSimpro('/api/v1.0/companies/1/jobs/?pageSize=50&columns=ID,Name,Customer');
        
        let schedules = jobsRes.data.map(job => ({
            jobId: job.ID,
            client: job.Customer ? (job.Customer.CompanyName || `${job.Customer.GivenName || ''} ${job.Customer.FamilyName || ''}`.trim() || job.Name) : job.Name || "SimPRO Job",
            site: "simPRO Site", time: "Recent"
        }));
        
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
