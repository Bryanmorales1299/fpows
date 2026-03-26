const fs = require('fs');
const token = '6c6b91755ff14c8ff1ffb843c0737955d7a3a88a';
const url = 'https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/';
const headers = { Authorization: `Bearer ${token}` };

async function run(id) {
    try {
        const res = await fetch(url + id + '?display=all', { headers });
        const data = await res.json();
        
        const darnMatchDesc = (data.Description || "").match(/DARN[:#\s\.]*([A-Z0-9-]+)/i);
        const darnMatchNotes = (data.Notes || "").match(/DARN[:#\s\.]*([A-Z0-9-]+)/i);
        
        let out = `\n--- JOB ${id} ---\n`;
        out += `Desc Regex: ${darnMatchDesc ? darnMatchDesc[0] + " -> " + darnMatchDesc[1] : 'null'}\n`;
        out += `Notes Regex: ${darnMatchNotes ? darnMatchNotes[0] + " -> " + darnMatchNotes[1] : 'null'}\n`;
        
        fs.appendFileSync('regex_test_log.txt', out);
    } catch(e) {}
}
async function main() {
    fs.writeFileSync('regex_test_log.txt', '');
    await run(418915);
    await run(419696);
    console.log("Done");
}
main();
