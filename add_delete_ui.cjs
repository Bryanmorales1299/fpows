const fs = require('fs');
const path = require('path');
const filePath = path.join(process.cwd(), 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

// 1. Update the table row rendering to include a delete button
const oldRowHtml = /tr\.innerHTML = `[\s\S]*?<td style="font-family:monospace">\${ts}<\/td>[\s\S]*?<\/td>\s*`;/;

const newRowHtml = `tr.innerHTML = \`
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
                    \`;`;

if (oldRowHtml.test(html)) {
    html = html.replace(oldRowHtml, newRowHtml);
} else {
    console.error("Could not find row HTML pattern");
    process.exit(1);
}

// 2. Add the deleteHistoryItem function
const insertPoint = /\$\('btn-history-close'\)\.addEventListener\('click', \(\) => \{[\s\S]*?\}\);/;
const deleteFunc = `$('btn-history-close').addEventListener('click', () => {
        $('history-modal-overlay').classList.remove('visible');
    });

    async function deleteHistoryItem(timestamp) {
        if (!confirm("Are you sure you want to delete this record?")) return;
        try {
            const res = await fetch('/api/delete-history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timestamp })
            });
            const result = await res.json();
            if (result.success) {
                // Refresh list by clicking history button again
                $('btn-history').click();
            } else {
                alert("Error: " + result.error);
            }
        } catch (err) {
            console.error("Delete failed:", err);
        }
    }`;

if (insertPoint.test(html)) {
    html = html.replace(insertPoint, deleteFunc);
} else {
    console.error("Could not find insert point for function");
    process.exit(1);
}

fs.writeFileSync(filePath, html);
console.log("Delete UI successfully integrated into index.html");
