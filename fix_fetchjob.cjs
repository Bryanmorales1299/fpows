const fs = require('fs');
const path = require('path');
const filePath = path.join(process.cwd(), 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

const missingCode = `
    // Show error banner
    function showError(msg) {
        const banner = $('error-banner');
        banner.textContent = msg;
        banner.style.display = 'block';
        setTimeout(() => banner.style.display = 'none', 6000);
    }

    // Core fetch function
    async function fetchJob() {
        const jobId = $('job-id-input').value.trim();
        if (!jobId) { showError('Please enter a Job ID.'); return; }

        $('loading-overlay').style.display = 'flex';
        $('loading-text').textContent = 'Fetching Job #' + jobId + ' from simPRO...';
        $('status-pill').className = 'status-pill pill-loading';
        $('status-pill').textContent = '⏳ Loading...';

        try {
            const res = await fetch('/api/job/' + jobId);
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);

            renderForm(data);
            $('status-pill').className = 'status-pill pill-done';
            $('status-pill').textContent = '✅ Job #' + jobId + ' loaded';
            $('btn-fetch').textContent = '🔄 Reload';
            $('btn-publish').style.display = '';
            $('btn-print').style.display = '';

            const works = data.OutstandingWorks || [];
            $('agent-insights').innerHTML = '<div class="insight-card"><h4>📋 Job #' + jobId + '</h4><p>' + (data.Client || 'Unknown') + ' — ' + (data.Site || 'Unknown') + '</p></div><div class="insight-card"><h4>🔧 Outstanding Works</h4><p>' + works.length + ' item(s) found</p></div><div class="insight-card"><h4>📅 AFSS Due</h4><p>' + (data.AFSSDue || 'Not set') + '</p></div>';

            speak('Job #' + jobId + ' loaded! Client: ' + data.Client + '. ' + works.length + ' outstanding works found.', 'Want me to verify the data?', 'fetch');
        } catch (err) {
            console.error("Fetch error:", err);
            showError('Failed to load Job #' + jobId + ': ' + err.message);
            $('status-pill').className = 'status-pill pill-error';
            $('status-pill').textContent = '❌ Error loading job';
        } finally {
            $('loading-overlay').style.display = 'none';
        }
    }

`;

const marker = '// Auto-fetch if a dropdown item is picked';
if (html.includes(marker)) {
    html = html.replace(marker, missingCode + '    ' + marker);
    fs.writeFileSync(filePath, html);
    console.log('SUCCESS: fetchJob and showError functions injected.');
} else {
    console.error('ERROR: Could not find marker in index.html');
}
