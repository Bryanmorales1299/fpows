const token = '6c6b91755ff14c8ff1ffb843c0737955d7a3a88a';
async function run() {
    const res = await fetch('https://redmen-uat.simprosuite.com/api/v1.0/companies/1/jobs/420436', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const job = await res.json();
    console.log("Site ID:", job.Site ? job.Site.ID : "None");
    console.log("Customer ID:", job.Customer ? job.Customer.ID : "None");
}
run();
