// Fiverr Portfolio PDF Generator for Ozawa Traders website
// Captures full-page screenshots of all key pages and combines into one PDF

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8000';
const OUT_DIR = path.join(__dirname, '..', 'portfolio-output');
const OUT_PDF = path.join(OUT_DIR, 'ozawatraders-portfolio.pdf');

const pages = [
    { url: '/', name: '01-Homepage', label: 'Homepage' },
    { url: '/customer', name: '02-Customers', label: 'Customers Page' },
    { url: '/contact', name: '03-Contact', label: 'Contact Page' },
    { url: '/power-cabinet', name: '04-PowerCabinet', label: 'Power Cabinet (Slider Mode)' },
    { url: '/matismart-breaker', name: '05-MatismartBreaker', label: 'Matismart Breaker' },
    { url: '/earth-resistance-tester', name: '06-EarthResistanceTester', label: 'Earth Resistance Tester' },
    { url: '/micro-feeder', name: '07-MicroFeeder', label: 'Micro Feeder (Slider Mode)' },
    { url: '/dilution-tank', name: '08-DilutionTank', label: 'Dilution Tank (Slider Mode)' },
    { url: '/rad', name: '09-Radiology', label: 'Radiology' },
    { url: '/card', name: '10-Cardiology', label: 'Cardiology' },
    { url: '/physio', name: '11-Physiotherapy', label: 'Physiotherapy' },
    { url: '/ambu', name: '12-Ambulances', label: 'Ambulances' },
    { url: '/admin/login', name: '13-AdminLogin', label: 'Admin Login' }
];

(async () => {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log('Launching headless Chromium...');
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });

    const pdfPaths = [];

    for (const p of pages) {
        console.log(`Capturing ${p.label}...`);
        try {
            // First try domcontentloaded (fast)
            await page.goto(BASE + p.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            // Wait for animations and images
            await new Promise(r => setTimeout(r, 3500));
            const pngFile = path.join(OUT_DIR, `${p.name}.png`);
            await page.screenshot({ path: pngFile, fullPage: true, type: 'png' });
            const pdfFile = path.join(OUT_DIR, `${p.name}.pdf`);
            await page.pdf({
                path: pdfFile,
                format: 'A4',
                printBackground: true,
                margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
            });
            pdfPaths.push(pdfFile);
            console.log(`  OK -> ${path.basename(pngFile)} + ${path.basename(pdfFile)}`);
        } catch (e) {
            console.log(`  SKIP (${p.url}): ${e.message}`);
        }
    }

    await browser.close();

    // Build a cover-page-style HTML and create a final combined PDF using pdf-lib
    const { PDFDocument } = require('pdf-lib');
    console.log('\nMerging into single PDF...');
    const merged = await PDFDocument.create();

    // Cover page
    const coverPage = merged.addPage([595, 842]); // A4 portrait
    const { rgb, StandardFonts } = require('pdf-lib');
    const fontBold = await merged.embedFont(StandardFonts.HelveticaBold);
    const font = await merged.embedFont(StandardFonts.Helvetica);
    coverPage.drawText('Ozawa Traders', { x: 50, y: 700, size: 36, font: fontBold, color: rgb(0.12, 0.23, 0.54) });
    coverPage.drawText('Industrial, Power & Medical Solutions', { x: 50, y: 660, size: 16, font: font, color: rgb(0.18, 0.31, 0.4) });
    coverPage.drawRectangle({ x: 50, y: 640, width: 100, height: 3, color: rgb(0.85, 0.58, 0.09) });
    coverPage.drawText('Full-Stack Web Development Portfolio', { x: 50, y: 590, size: 18, font: fontBold, color: rgb(0.05, 0.1, 0.2) });
    const meta = [
        '',
        'Tech Stack:',
        '  - Node.js / Express / EJS',
        '  - TailwindCSS',
        '  - JSON file-based CMS',
        '  - Nginx + PM2 on AWS EC2',
        '  - Custom Admin Panel',
        '  - Image Slider, Certificate Carousel, Email Integration',
        '',
        'Features:',
        '  - Responsive design with animated background',
        '  - Custom multi-category navigation menu',
        '  - Admin CRUD for content, products, customers, footer',
        '  - Image upload with gallery + slider modes per category',
        '  - Contact form with SMTP + WhatsApp notification',
        '  - Premium color scheme (Navy + Gold accent)',
        '',
        'Live: https://ozawatraders.org'
    ];
    let yPos = 540;
    for (const line of meta) {
        coverPage.drawText(line, { x: 50, y: yPos, size: 12, font: font, color: rgb(0.18, 0.18, 0.2) });
        yPos -= 18;
    }

    // Merge all page PDFs
    for (const p of pdfPaths) {
        const bytes = fs.readFileSync(p);
        const src = await PDFDocument.load(bytes);
        const copied = await merged.copyPages(src, src.getPageIndices());
        copied.forEach(pg => merged.addPage(pg));
    }

    const mergedBytes = await merged.save();
    fs.writeFileSync(OUT_PDF, mergedBytes);
    console.log(`\nDone! Final PDF: ${OUT_PDF}`);
    console.log(`Size: ${(mergedBytes.length / 1024 / 1024).toFixed(2)} MB`);

    // Clean up individual PDFs (keep PNGs)
    for (const p of pdfPaths) fs.unlinkSync(p);
})();
