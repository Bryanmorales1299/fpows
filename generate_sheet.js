import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the required arguments are provided
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: node generate_sheet.js <JobID> [data.json]");
    console.error("Example: node generate_sheet.js 423242");
    process.exit(1);
}

const jobId = args[0];
// Use the provided JSON payload file, or fallback to the sample mock data
let jsonSourcePath = args[1] 
    ? path.resolve(process.cwd(), args[1]) 
    : path.join(__dirname, 'simpro-sample.json');

console.log(`Loading FPOWS data from: ${jsonSourcePath}`);

let fpowData;
try {
    const rawData = fs.readFileSync(jsonSourcePath, 'utf8');
    fpowData = JSON.parse(rawData);
    
    // Override the mock jobId to make it look realistic if fallback was used
    fpowData.JobID = parseInt(jobId);
} catch (err) {
    console.error(`Failed to load data: ${err.message}`);
    process.exit(1);
}

// Read the original FPOWS UI template
const templatePath = path.join(__dirname, 'index.html');
let htmlTemplate;
try {
    htmlTemplate = fs.readFileSync(templatePath, 'utf8');
} catch (err) {
    console.error(`Failed to read FPOWS template index.html: ${err.message}`);
    process.exit(1);
}

console.log(`Generating FPOWS Document for Job ID: ${jobId}...`);

// Inject the data and auto-trigger the render process natively inside the HTML
// We will replace the closing </body> tag with our auto-render script
const injectScript = `
<script>
    // Auto-injected by Agent FPOWS Generator
    const PUSHED_DATA = ${JSON.stringify(fpowData, null, 2)};
    
    document.addEventListener("DOMContentLoaded", () => {
        // Hide the top control bar since this is a pre-rendered static output
        document.querySelector('.control-bar').style.display = 'none';
        
        // Hide overlay safely
        document.getElementById('loading-overlay').classList.remove('visible');
        
        // Call the natively existing render function defined in index.html
        renderForm(PUSHED_DATA);
        
        console.log("FPOWS form fully populated via static injection.");
    });
</script>
</body>
`;

const finalHtml = htmlTemplate.replace('</body>', injectScript);

// Output the static prepopulated sheet
const outputFilename = `fpows_output_${jobId}.html`;
const outputPath = path.join(__dirname, outputFilename);

try {
    fs.writeFileSync(outputPath, finalHtml, 'utf8');
    console.log(`✅ Success! static FPOWS sheet generated at: ${outputPath}`);
} catch (err) {
    console.error(`Failed to write output file: ${err.message}`);
    process.exit(1);
}
