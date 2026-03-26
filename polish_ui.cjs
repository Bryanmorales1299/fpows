const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// 1. Column Widths
html = html.replace('<th style="width:9%">Equipment Type</th>', '<th style="width:12%">Equipment Type</th>');
html = html.replace('<th style="width:30%">Issue</th>', '<th style="width:27%">Issue</th>');

// 2. History Table Recipients - replacing the TD part
const oldTd = `<td title="\${log.to || ''}" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;">
                            \${log.to || '—'}
                        </td>`;
const newTd = `<td style="font-size: 0.72rem; line-height: 1.4; color: #444; padding: 10px;">
                            <div style="margin-bottom: 4px;"><strong>Client:</strong> \${log.clientEmail || log.to || '—'}</div>
                            <div><strong>Manager:</strong> \${log.managerEmail || '—'}</div>
                        </td>`;

html = html.replace(oldTd, newTd);

fs.writeFileSync('index.html', html);
console.log("UI Polish Applied Successfully");
