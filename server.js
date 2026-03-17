import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// SimPRO credentials
const SIMPRO_BASE_URL = process.env.SIMPRO_BASE_URL;
const SIMPRO_ACCESS_TOKEN = process.env.SIMPRO_ACCESS_TOKEN;

const simproClient = axios.create({
    baseURL: SIMPRO_BASE_URL,
    headers: {
        'Authorization': `Bearer ${SIMPRO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

// Mock MCP tool behavior via REST API for FPOWS data
app.get('/api/job/:id', async (req, res) => {
    const jobId = req.params.id;
    console.log(`[REAL DATA] Fetching Job #${jobId} from Company 1...`);
    try {
        const jobRes = await simproClient.get(`/api/v1.0/companies/1/jobs/${jobId}`);
        const jobData = jobRes.data;

        // 1. Site Info
        let siteName = jobData.Site?.Name || "Unknown Site";
        
        // 2. Extract specific contact info from Description (Very common in Redmen UAT)
        const desc = jobData.Description || "";
        const nameMatch = desc.match(/Name:\s*([^<\n\r]+)/i);
        const phoneMatch = desc.match(/Phone[^:]*:\s*([^<\n\r]+)/i);
        const emailMatch = desc.match(/Email:\s*([^<\n\r]+)/i);

        // 3. Contact Fallback Logic
        let contactName = jobData.Contact?.Name || "";
        let contactPhone = jobData.Contact?.Phone || "";
        let contactEmail = jobData.Contact?.Email || "";

        // If job contact is missing, try description parse
        if (!contactName && nameMatch) contactName = nameMatch[1].trim();
        if (!contactPhone && phoneMatch) contactPhone = phoneMatch[1].trim();
        if (!contactEmail && emailMatch) contactEmail = emailMatch[1].trim();

        // Still missing? Try site contacts
        if (!contactName && jobData.Site?.ID) {
            try {
                const siteContactsRes = await simproClient.get(`/api/v1.0/companies/1/sites/${jobData.Site.ID}/contacts/`);
                if (siteContactsRes.data && siteContactsRes.data.length > 0) {
                    const sc = siteContactsRes.data[0];
                    contactName = `${sc.GivenName || ''} ${sc.FamilyName || ''}`.trim();
                }
            } catch (e) { }
        }

        // 4. Customer Info
        let clientName = "Unknown Client";
        let realPhone = "";
        let realEmail = "";

        if (jobData.Customer && jobData.Customer.ID) {
            try {
                const custRes = await simproClient.get(`/api/v1.0/companies/1/customers/${jobData.Customer.ID}`);
                const cust = custRes.data;
                clientName = cust.CompanyName || `${cust.GivenName || ''} ${cust.FamilyName || ''}`.trim() || cust.Name;
                if (!contactPhone) realPhone = cust.Phone || cust.AltPhone || "";
                if (!contactEmail) realEmail = cust.Email || "";
            } catch (e) {
                clientName = jobData.Customer.CompanyName || jobData.Customer.Name || "Unknown Client";
            }
        }

        // 5. Date Mapping (Actual simPRO Data)
        const dateIssued = jobData.DateIssued ? new Date(jobData.DateIssued).toLocaleDateString('en-AU') : "Not Issued";
        const dateCompleted = jobData.CompletedDate ? new Date(jobData.CompletedDate).toLocaleDateString('en-AU') : "Pending";

        // 6. AFSS Due Date (Heuristic calculation if not in custom fields)
        const afssDate = jobData.DateIssued ? new Date(new Date(jobData.DateIssued).setFullYear(new Date(jobData.DateIssued).getFullYear() + 1)).toLocaleDateString('en-AU') : "Check simPRO";

        const descriptionStrip = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        // 7. Quote Discovery
        let quoteNumber = "";
        try {
            const quoteRes = await simproClient.get(`/api/v1.0/companies/1/quotes/?JobID=${jobId}`);
            if (quoteRes.data && quoteRes.data.length > 0) {
                quoteNumber = quoteRes.data[0].ID;
            } else if (jobData.Quote && jobData.Quote.ID) {
                 quoteNumber = jobData.Quote.ID;
            }
        } catch (e) { }

        const formattedData = {
            JobID: jobId,
            Site: siteName,
            SiteContact: {
                Name: contactName || clientName,
                Phone: contactPhone || realPhone,
                Email: contactEmail || realEmail
            },
            Client: clientName,
            DateCallMade: dateIssued,
            DateCompleted: dateCompleted,
            AFSSDue: afssDate, 
            ServiceDue: {
                Type: (jobData.Name || "").toLowerCase().includes('12 monthly') ? "12 Monthly" : "6 Monthly",
                Month: new Date(jobData.DateIssued || new Date()).toLocaleString('default', { month: 'long' }),
                Year: new Date(jobData.DateIssued || new Date()).getFullYear()
            },
            OutstandingWorks: []
        };

        if (descriptionStrip) {
            formattedData.OutstandingWorks.push({
                Date: dateIssued,
                EquipmentType: "General Maintenance",
                Issue: descriptionStrip.substring(0, 150) + (descriptionStrip.length > 150 ? '...' : ''),
                DARN: "", // Potentially scan CustomFields if we find the ID
                Quote: quoteNumber || "",
                Job: jobId,
                Responsibility: "",
                Comment: "Imported from Description",
                Status: jobData.Stage || "pending"
            });
        }
        
        console.log(`[SUCCESS] REAL data fetched for Job #${jobId}`);
        res.json(formattedData);
    } catch (err) {
        const errorMsg = err.response?.data?.errors?.[0]?.message || err.response?.data?.message || err.message;
        console.error(`[ERROR] REAL FETCH FAILED for job ${jobId}: ${errorMsg}`);
        res.status(500).json({ error: `REAL DATA ERROR: ${errorMsg}` });
    }
});

app.get('/api/schedules/today', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Since UAT has no schedules, we will fetch the 50 most recent jobs instead
        // This ensures the dropdown actually contains real data for the user to select
        const jobsRes = await simproClient.get('/api/v1.0/companies/1/jobs/?pageSize=50&columns=ID,Name,Customer');
        
        let schedules = [];
        if (jobsRes.data && jobsRes.data.length > 0) {
            schedules = jobsRes.data.map(job => ({
                jobId: job.ID,
                client: job.Customer ? (job.Customer.CompanyName || `${job.Customer.GivenName || ''} ${job.Customer.FamilyName || ''}`.trim() || job.Name) : job.Name || "SimPRO Job",
                site: "simPRO Site",
                time: "Recent"
            }));
        } 
        
        if (schedules.length === 0) {
            schedules = [
                { jobId: 423242, client: "Jonny Macleod Retirement Village", site: "48 Victory Parade Wallsond", time: "09:00 AM" },
                { jobId: 427896, client: "Example Corp", site: "123 Business Rd", time: "13:00 PM" }
            ];
        }
        res.json({ date: today, schedules });
    } catch (err) {
        console.error("Error fetching jobs for dropdown:", err.response?.data || err.message);
        // Robust fallback to demo data
        res.json({ date: "Today", schedules: [
            { jobId: 423242, client: "Jonny Macleod Retirement Village", site: "48 Victory Parade Wallsond", time: "09:00 AM" },
            { jobId: 427896, client: "Example Corp", site: "123 Business Rd", time: "13:00 PM" }
        ]});
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`FPOWS sheet interface: http://localhost:${PORT}/index.html`);
});
