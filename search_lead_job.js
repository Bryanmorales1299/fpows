const token = '6c6b91755ff14c8ff1ffb843c0737955d7a3a88a';
const url = 'https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/';
const headers = { Authorization: `Bearer ${token}` };

async function searchJobs() {
    try {
        const res = await fetch(url + '?pageSize=50', { headers });
        const jobs = await res.json();
        let foundLead = null;
        let foundDarn = null;

        for (const j of jobs) {
            try {
                const detailRes = await fetch(url + j.ID, { headers });
                const dj = await detailRes.json();
                
                // Check Lead
                if (dj.Lead || (dj.Description || "").match(/Lead[:#\s\.]*([A-Z0-9-]+)/i)) {
                    if (!foundLead) foundLead = j.ID;
                }
                
                // Check DARN in desc
                if ((dj.Description || "").match(/DARN[:#\s\.]*([A-Z0-9-]+)/i)) {
                    if (!foundDarn) foundDarn = j.ID;
                }
                
                // Check Notes
                if (!foundLead || !foundDarn) {
                    try {
                        const notesRes = await fetch(url + j.ID + '/notes/', { headers });
                        const notes = await notesRes.json();
                        if (notes) {
                            for (const n of notes) {
                                if (!foundLead && (n.Note || "").match(/Lead[:#\s\.]*([A-Z0-9-]+)/i)) foundLead = j.ID;
                                if (!foundDarn && (n.Note || "").match(/DARN[:#\s\.]*([A-Z0-9-]+)/i)) foundDarn = j.ID;
                            }
                        }
                    } catch(e) {}
                }
                
                if (foundLead && foundDarn) break;
            } catch (e) {}
        }
        
        console.log(`Job with Lead: ${foundLead || 'None found in last 50'}`);
        console.log(`Job with DARN: ${foundDarn || 'None found in last 50'}`);
    } catch (e) { console.error(e.message); }
}
searchJobs();
