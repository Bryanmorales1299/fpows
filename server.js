import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// SimPRO credentials
const SIMPRO_ACCESS_TOKEN = "6c6b91755ff14c8ff1ffb843c0737955d7a3a88a";

// We'll use absolute URLs instead of baseURL to avoid Axios configuration issues in Cloud Run
const getSimpro = async (path) => {
    // HARDCODED URL to solve the "Invalid URL" mystery once and for all
    const base = "https://redmen-uat.simprosuite.com";
    const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    console.log(`[FETCHING] ${url}`);
    
    return axios.get(url, {
        headers: {
            'Authorization': `Bearer ${SIMPRO_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });
};

// Mock MCP tool behavior via REST API for FPOWS data
app.get('/api/job/:id', async (req, res) => {
    const jobId = req.params.id;
    try {
        const jobRes = await getSimpro(`/api/v1.0/companies/1/jobs/${jobId}`);
        const jobData = jobRes.data;

        // 1. Site Info
        let siteName = jobData.Site?.Name || "Unknown Site";
        
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

        res.json({
            JobID: jobId, Site: siteName,
            SiteContact: { Name: contactName || clientName, Phone: contactPhone || realPhone, Email: contactEmail || realEmail },
            Client: clientName, DateCallMade: dateIssued, DateCompleted: dateCompleted, AFSSDue: afssDate, 
            ServiceDue: {
                Type: (jobData.Name || "").toLowerCase().includes('12 monthly') ? "12 Monthly" : "6 Monthly",
                Month: new Date(jobData.DateIssued || new Date()).toLocaleString('default', { month: 'long' }),
                Year: new Date(jobData.DateIssued || new Date()).getFullYear()
            },
            OutstandingWorks: desc ? [{
                Date: dateIssued, EquipmentType: "Maintenance", Issue: descriptionStrip.substring(0, 150),
                Quote: quoteNumber, Job: jobId, Status: jobData.Stage || "pending"
            }] : []
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
        const jobsRes = await getSimpro('/api/v1.0/companies/1/jobs/?pageSize=50&columns=ID,Name,Customer');
        
        let schedules = jobsRes.data.map(job => ({
            jobId: job.ID,
            client: job.Customer ? (job.Customer.CompanyName || `${job.Customer.GivenName || ''} ${job.Customer.FamilyName || ''}`.trim() || job.Name) : job.Name || "SimPRO Job",
            site: "simPRO Site", time: "Recent"
        }));
        
        if (schedules.length === 0) {
            schedules = [{ jobId: 423242, client: "Offline Demo: Jonny Macleod Village", site: "Offline Site", time: "09:00 AM" }];
        }
        res.json({ date: today, schedules });
    } catch (err) {
        const errorMsg = err.response?.data?.errors?.[0]?.message || err.message;
        const failedUrl = err.config?.url || "Unknown URL";
        console.error(`[ERROR] Fetch failed for ${failedUrl}: ${errorMsg}`);
        res.json({ date: "Offline", schedules: [
            { jobId: 423242, client: "Offline Demo: Jonny Macleod Village", site: "Offline Site", time: "09:00 AM" }
        ]});
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`FPOWS sheet interface: http://localhost:${PORT}/index.html`);
});
