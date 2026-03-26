const fs = require('fs');
const path = require('path');
const filePath = path.join(process.cwd(), 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

// 1. Restore Outstanding Works rendering in renderForm
// We'll use a string search + index since regex with backticks is painful
const worksStartMarker = 'const works = data.OutstandingWorks || [];';
const worksEndMarker = 'tbody.appendChild(tr);\n            });\n        }';

const startIndex = html.indexOf(worksStartMarker);
// We need to find the specific broken loop that uses log.jobId instead of w.Date
if (startIndex !== -1) {
    // Find the next '});' that ends the forEach
    const loopEndIndex = html.indexOf('});', startIndex);
    if (loopEndIndex !== -1) {
        const fullBrokenBlock = html.substring(startIndex, loopEndIndex + 3);
        const correctWorksBlock = `const works = data.OutstandingWorks || [];

        if (works.length > 0) {
            works.forEach(w => {
                const tr = document.createElement('tr');
                tr.innerHTML = \`
                    <td contenteditable="true">\${w.Date || '—'}</td>
                    <td contenteditable="true">\${w.EquipmentType || '—'}</td>
                    <td contenteditable="true">\${w.Issue || '—'}</td>
                    <td contenteditable="true">\${w.Lead || '—'}</td>
                    <td contenteditable="true">\${w.DARN || '—'}</td>
                    <td contenteditable="true">\${w.Quote || '—'}</td>
                    <td contenteditable="true">\${w.Job || '—'}</td>
                    <td contenteditable="true">\${w.Responsibility || '—'}</td>
                    <td contenteditable="true">\${w.Comment || '—'}</td>
                    <td class="col-status">\${badgeHtml(w.Status)}</td>
                \`;
                tbody.appendChild(tr);
            });
        } else {
             tbody.innerHTML = '<tr class="empty-row"><td colspan="10" style="text-align:center; padding:20px; color:#999;">No outstanding works found.</td></tr>';
        }`;
        html = html.replace(fullBrokenBlock, correctWorksBlock);
    }
}

// 2. Restore initSchedules function
const scriptStartMarker = 'const $ = id => document.getElementById(id);';
const initSchedulesFunc = `const $ = id => document.getElementById(id);
    
    async function initSchedules() {
        try {
            const res = await fetch('/api/schedules');
            const data = await res.json();
            const select = $('schedule-select');
            if (data.jobs && data.jobs.length > 0) {
                select.innerHTML = '<option value="">-- Select Recent Job --</option>' + 
                    data.jobs.map(j => \`<option value="\${j.JobID}">\${j.Client} (\${j.JobID})</option>\`).join('');
            } else {
                select.innerHTML = '<option value="">No jobs scheduled for today</option>';
            }
        } catch (err) {
            console.error("Failed to load schedules:", err);
            $('schedule-select').innerHTML = '<option value="">Error loading jobs</option>';
        }
    }`;
html = html.replace(scriptStartMarker, initSchedulesFunc);

// 3. Proper History Event Listener
// Look for the code that is floating around 'Failed to load history'
const historyErrorMarker = "tbody.innerHTML = '<tr><td colspan=\"4\" style=\"text-align:center; padding:20px; color:red;\">Failed to load history.</td></tr>';";
const historyLogicEnd = html.indexOf(historyErrorMarker);
if (historyLogicEnd !== -1) {
    // Find the start of this broken block (it starts with } else { or similar usually)
    // Actually, let's just replace from 'tbody.appendChild(tr);' after the broken loop
    const firstEndMatch = html.indexOf('tbody.appendChild(tr);', startIndex + 100); 
    const blockStart = html.indexOf('}', firstEndMatch);
    const blockEnd = html.indexOf('});', historyLogicEnd);
    
    if (blockStart !== -1 && blockEnd !== -1) {
        const fullFloatingBlock = html.substring(blockStart, blockEnd + 3);
        const properHistoryLogic = `
    // --- History Logic ---
    $('btn-history').addEventListener('click', async () => {
        $('history-modal-overlay').classList.add('visible');
        const tbody = $('history-list-body');
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Loading history...</td></tr>';
        
        try {
            const res = await fetch('/api/logs');
            const data = await res.json();
            
            if (data.logs && data.logs.length > 0) {
                tbody.innerHTML = '';
                data.logs.forEach(log => {
                    const tr = document.createElement('tr');
                    const ts = new Date(log.timestamp).toLocaleString('en-AU', { 
                        day: '2-digit', month: '2-digit', year: 'numeric', 
                        hour: '2-digit', minute: '2-digit' 
                    });
                    
                    tr.innerHTML = \`
                        <tr style="position:relative;">
                            <td style="font-family:monospace">\${ts}</td>
                            <td style="font-weight:700">#\${log.jobId || 'N/A'}</td>
                            <td style="color:#e63946">\${log.client || '—'}</td>
                            <td style="font-size: 0.72rem; line-height: 1.4; color: #444; padding:10px; display:flex; justify-content:space-between; align-items:center;">
                                <div>
                                    <div style="margin-bottom: 4px;"><strong>Client:</strong> \${log.clientEmail || log.to || '—'}</div>
                                    <div><strong>Manager:</strong> \${log.managerEmail || '—'}</div>
                                </div>
                                <button onclick="deleteHistoryItem('\${log.timestamp}')" style="background:none; border:none; color:#e63946; cursor:pointer; font-size:16px; margin-left:10px;" title="Delete Record">🗑️</button>
                            </td>
                        </tr>
                    \`;
                    tbody.appendChild(tr);
                });
            } else {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#999;">No history found yet.</td></tr>';
            }
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:red;">Failed to load history.</td></tr>';
        }
    });`;
        html = html.replace(fullFloatingBlock, properHistoryLogic);
    }
}

fs.writeFileSync(filePath, html);
console.log("Index.html structural repairs COMPLETE (Resilient version).");
