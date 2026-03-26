const token = '6c6b91755ff14c8ff1ffb843c0737955d7a3a88a';
const companyId = '1';
const siteId = '86424'; // From user screenshots
const headers = { Authorization: `Bearer ${token}` };

async function test(label, url) {
    try {
        console.log(`Testing ${label}: ${url}`);
        const res = await fetch(url, { headers });
        console.log(`Status: ${res.status} ${res.statusText}`);
        if (!res.ok) {
            const data = await res.text();
            console.log(`Error Body: ${data}`);
        }
    } catch (e) {
        console.log(`Fetch Error: ${e.message}`);
    }
}

async function run() {
    await test("Jobs with Site.ID", `https://redmen-uat.simprosuite.com/api/v1.0/companies/${companyId}/jobs/?Site.ID=${siteId}&pageSize=50`);
    await test("Quotes with Site.ID and Stage", `https://redmen-uat.simprosuite.com/api/v1.0/companies/${companyId}/quotes/?Site.ID=${siteId}&Stage=Pending&pageSize=50`);
    await test("Quotes with Site.ID only", `https://redmen-uat.simprosuite.com/api/v1.0/companies/${companyId}/quotes/?Site.ID=${siteId}&pageSize=50`);
}
run();
