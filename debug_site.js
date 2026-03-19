import axios from 'axios';
import fs from 'fs';
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/SIMPRO_ACCESS_TOKEN=["']?([^"']+)["']?/);
const token = m[1].trim();

async function run() {
    try {
        const jRes = await axios.get("https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/420430", {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`JOB: 420430, SITE_ID: ${jRes.data.Site.ID}`);
        
        const sjRes = await axios.get(`https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/?SiteID=${jRes.data.Site.ID}&pageSize=50`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`SITE_JOBS_COUNT: ${sjRes.data.length}`);
        console.log(`JOBS: ${sjRes.data.map(m => m.ID).join(', ')}`);
        console.log(`STATUSES: ${sjRes.data.map(m => m.Status.Name).join(', ')}`);
    } catch (e) { console.error(e.message); }
}

run();
