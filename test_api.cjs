const http = require('http');

http.get('http://localhost:3000/api/schedules/today', (res) => {
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
        try {
            const parsedData = JSON.parse(rawData);
            console.log('API Status Code:', res.statusCode);
            console.log('API Response:', JSON.stringify(parsedData, null, 2));
        } catch (e) {
            console.error('Failed to parse response:', e.message);
            console.log('Raw Response:', rawData);
        }
    });
}).on('error', (e) => {
    console.error(`Got error: ${e.message}`);
});
