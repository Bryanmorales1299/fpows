const fs = require('fs');
const path = require('path');
const filePath = path.join(process.cwd(), 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

// 1. Table Headers
html = html.replace(/<th style="width: 30%">Client<\/th>\s*<th style="width: 30%">Recipients<\/th>/, 
                    '<th style="width: 20%">Client</th>\n                        <th style="width: 40%">Recipients</th>');

// 2. Recipients TD
// Using a simpler regex that matches the core structure
const oldTdPatterns = [
    /<td title="\${log\.to \|\| ''}" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;">\s*\${log\.to \|\| '—'}\s*<\/td>/,
    /<td title="\${log\.to \|\| ''}" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;">[\s\S]*?\${log\.to \|\| '—'}[\s\S]*?<\/td>/
];

const newTd = `<td style="font-size: 0.72rem; line-height: 1.4; color: #444; padding:10px;">
                            <div style="margin-bottom: 4px;"><strong>Client:</strong> \${log.clientEmail || log.to || '—'}</div>
                            <div><strong>Manager:</strong> \${log.managerEmail || '—'}</div>
                        </td>`;

let replaced = false;
for (const pattern of oldTdPatterns) {
    if (pattern.test(html)) {
        html = html.replace(pattern, newTd);
        replaced = true;
        break;
    }
}

if (!replaced) {
    console.error("Could not find the target TD pattern in index.html");
    process.exit(1);
}

fs.writeFileSync(filePath, html);
console.log("Sent History Recipients UI fixed.");
