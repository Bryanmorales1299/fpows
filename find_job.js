import axios from 'axios';
import fs from 'fs';
const env = fs.readFileSync('.env', 'utf8');
const tokenMatch = env.match(/SIMPRO_ACCESS_TOKEN=["']?([^"']+)["']?/);
if (!tokenMatch) {
    console.error("No token found");
    process.exit(1);
}
const token = tokenMatch[1].trim();

async function run() {
    try {
        console.log("Searching for multi-issue jobs...");
        // Fetch recent jobs to find sites with multiple entries
        const jobsRes = await axios.get("https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/?pageSize=100&columns=ID,Name,Site", {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        const siteJobs = {};
        for (const j of jobsRes.data) {
            const sid = j.Site?.ID || j.Site;
            if (!sid) continue;
            if (!siteJobs[sid]) siteJobs[sid] = [];
            siteJobs[sid].push(j);
        }

        for (const sid in siteJobs) {
            if (siteJobs[sid].length > 1) {
                const multi = siteJobs[sid];
                console.log(`\nFOUND_SITE_ID: ${sid}`);
                console.log(`Jobs: ${multi.map(m => m.ID).join(', ')}`);
                console.log(`Names: ${multi.map(m => m.Name).join(' | ')}`);
                // Check if any of these have multiple cost centers
                for (const j of multi) {
                    try {
                        const sRes = await axios.get(`https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/${j.ID}/sections/`, {
                            headers: { Authorization: `Bearer ${token}` }
                        });
                        if (sRes.data.length > 0) {
                            const ccRes = await axios.get(`https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/${j.ID}/sections/${sRes.data[0].ID}/costCenters/`, {
                                headers: { Authorization: `Bearer ${token}` }
                            });
                            if (ccRes.data.length > 1) {
                                console.log(`>>> THIS JOB ${j.ID} HAS ${ccRes.data.length} COST CENTERS!`);
                            }
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (err) {
        console.error("Search failed:", err.message);
    }
}

run();
