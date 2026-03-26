const token = '6c6b91755ff14c8ff1ffb843c0737955d7a3a88a';
const url = 'https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/420436';
const headers = { Authorization: `Bearer ${token}` };

async function run() {
    try {
        const res = await fetch(url + '?display=all', { headers });
        const data = await res.json();
        console.log("JOB PROPERTIES:");
        console.log(Object.keys(data).filter(k => Array.isArray(data[k]) || typeof data[k] === 'string'));
        
        console.log("\nNote Fields in Detail:");
        if (data.Notes) console.log("Job.Notes:", data.Notes);
        if (data.Description) console.log("Job.Description length:", data.Description.length);
        
        const notesRes = await fetch(url + '/notes/', { headers });
        if (notesRes.ok) {
            const notes = await notesRes.json();
            console.log("\n/notes/ Endpoint Response:", notes);
        } else {
            console.log("\n/notes/ Endpoint FAILED:", notesRes.statusText);
        }
    } catch(e) { console.error(e.message); }
}
run();
