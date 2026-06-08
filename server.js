try { require('dotenv').config(); } catch {}
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let helmet, rateLimit;
try { helmet = require('helmet'); } catch {}
try { rateLimit = require('express-rate-limit'); } catch {}

const { requireAuth, injectUser } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 8000;
const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD && !process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET environment variable is required in production. Set it in .env or systemd unit.');
    process.exit(1);
}

app.set('trust proxy', 1);
const ROOT = __dirname;
// Writable data lives under PERSIST_DIR so it survives redeploys on hosts with an
// ephemeral filesystem (Railway/Render). Mount a volume and set PERSIST_DIR to it.
// Defaults to the repo dir for local development (unchanged behaviour).
const PERSIST_DIR = process.env.PERSIST_DIR || ROOT;
const DATA_DIR = path.join(PERSIST_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'content.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
const UPLOAD_DIR = path.join(PERSIST_DIR, 'img', 'uploads');
const ENV_FILE = path.join(PERSIST_DIR, '.env');

// Bundled copies shipped in the git repo, used to seed the persistent dir once.
const BUNDLED_DATA_DIR = path.join(ROOT, 'data');
const BUNDLED_UPLOAD_DIR = path.join(ROOT, 'img', 'uploads');

seedPersistentData();

// On first boot against an empty volume, copy the committed content/images across
// and create an admin login. No-op when PERSIST_DIR is the repo (local dev).
function seedPersistentData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const bundledContent = path.join(BUNDLED_DATA_DIR, 'content.json');
    if (!fs.existsSync(DATA_FILE) && fs.existsSync(bundledContent) && bundledContent !== DATA_FILE) {
        fs.copyFileSync(bundledContent, DATA_FILE);
        console.log('[seed] content.json copied to volume');
    }

    if (!fs.existsSync(AUTH_FILE)) {
        const bundledAuth = path.join(BUNDLED_DATA_DIR, 'auth.json');
        if (fs.existsSync(bundledAuth) && bundledAuth !== AUTH_FILE) {
            fs.copyFileSync(bundledAuth, AUTH_FILE);
        } else {
            const username = process.env.ADMIN_USERNAME || 'admin';
            const password = process.env.ADMIN_PASSWORD || 'changeme-now';
            fs.writeFileSync(AUTH_FILE, JSON.stringify({
                username,
                passwordHash: bcrypt.hashSync(password, 10)
            }, null, 2), 'utf8');
            console.log(`[seed] auth.json created for admin "${username}" — change the password after first login`);
        }
    }

    if (fs.existsSync(BUNDLED_UPLOAD_DIR) && BUNDLED_UPLOAD_DIR !== UPLOAD_DIR) {
        for (const f of fs.readdirSync(BUNDLED_UPLOAD_DIR)) {
            const dest = path.join(UPLOAD_DIR, f);
            if (!fs.existsSync(dest)) {
                try { fs.copyFileSync(path.join(BUNDLED_UPLOAD_DIR, f), dest); } catch {}
            }
        }
    }
  } catch (e) {
    // A read-only filesystem (e.g. misconfigured host) must not crash boot.
    console.error('[seed] could not seed persistent data:', e.message);
  }
}

function readContent() {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeContent(data) {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
}

function readAuth() {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
}

function writeAuth(data) {
    const tmp = AUTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, AUTH_FILE);
}

function readMessages() {
    if (!fs.existsSync(MSG_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); } catch { return []; }
}

function writeMessages(data) {
    const tmp = MSG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, MSG_FILE);
}

function sendEmail({ subject, text, replyTo }) {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const to = process.env.EMAIL_TO || 'ozawatraders786@gmail.com';
    if (!user || !pass) {
        console.log('[Email] SMTP not configured (SMTP_USER/SMTP_PASS missing) — skipping');
        return;
    }
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '465', 10),
        secure: process.env.SMTP_SECURE !== 'false',
        auth: { user, pass }
    });
    transporter.sendMail({
        from: `"Ozawa Traders Site" <${user}>`,
        to,
        replyTo: replyTo || user,
        subject,
        text
    }).then(info => console.log('[Email] sent ->', info.messageId, 'to', to))
      .catch(err => console.error('[Email] error:', err.message));
}

function sendWhatsApp(messageText) {
    const phone = process.env.WHATSAPP_TARGET || '923167972059';
    const apiKey = process.env.CALLMEBOT_API_KEY;
    if (!apiKey) {
        console.log('[WhatsApp] CALLMEBOT_API_KEY not set — skipping');
        return;
    }
    const https = require('https');
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(messageText)}&apikey=${encodeURIComponent(apiKey)}`;
    https.get(url, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => console.log('[WhatsApp] sent ->', res.statusCode, body.slice(0, 120)));
    }).on('error', err => console.error('[WhatsApp] error:', err.message));
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safe = path.basename(file.originalname, ext).replace(/[^a-z0-9-_]/gi, '-').slice(0, 40);
        cb(null, `${Date.now()}-${safe || 'upload'}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = /\.(jpe?g|png|gif|webp|svg)$/i.test(file.originalname);
        cb(ok ? null : new Error('Only image files allowed'), ok);
    }
});

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));

if (helmet) {
    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' }
    }));
}

const staticOpts = { maxAge: '7d', immutable: false, etag: true };
// Uploaded images live on the persistent volume; mount it ahead of the bundled /img.
app.use('/img/uploads', express.static(UPLOAD_DIR, staticOpts));
app.use('/img', express.static(path.join(ROOT, 'img'), staticOpts));
app.use('/css', express.static(path.join(ROOT, 'css'), staticOpts));
app.use('/js', express.static(path.join(ROOT, 'js'), staticOpts));
app.use('/fonts', express.static(path.join(ROOT, 'fonts'), { maxAge: '30d', immutable: true }));

const robotsTxt = `User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: https://ozawatraders.org/sitemap.xml\n`;
app.get('/robots.txt', (_req, res) => res.type('text/plain').send(robotsTxt));

app.get('/sitemap.xml', (_req, res) => {
    const base = 'https://ozawatraders.org';
    const urls = ['/', '/it', '/customer', '/contact', '/power-cabinet', '/matismart-breaker', '/earth-resistance-tester', '/micro-feeder', '/dilution-tank', '/rad', '/card', '/physio', '/ambu'];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls.map(u => `  <url><loc>${base}${u}</loc><changefreq>monthly</changefreq></url>`).join('\n') +
        '\n</urlset>\n';
    res.type('application/xml').send(xml);
});

app.get('/favicon.ico', (_req, res) => {
    const logoPath = path.join(ROOT, 'img', 'logo.png');
    if (fs.existsSync(logoPath)) return res.sendFile(logoPath);
    res.status(204).end();
});

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PROD,
        maxAge: 1000 * 60 * 60 * 8
    }
}));

app.use(injectUser);
app.use((req, res, next) => {
    res.locals.content = readContent();
    res.locals.req = req;
    res.locals.flash = req.session.flash || null;
    if (req.session.flash) delete req.session.flash;
    if (req.session.user) {
        try { res.locals.unreadMessages = readMessages().filter(m => !m.read).length; }
        catch { res.locals.unreadMessages = 0; }
    } else {
        res.locals.unreadMessages = 0;
    }
    next();
});

function flash(req, type, msg) {
    req.session.flash = { type, msg };
}

// ----- Maintenance mode (toggle via MAINTENANCE=true in .env) -----
app.use((req, res, next) => {
    if (process.env.MAINTENANCE !== 'true') return next();
    if (req.path.startsWith('/admin')) return next();
    res.set('Cache-Control', 'no-store');
    res.render('maintenance');
});

// ----- Public routes -----
app.get('/', (_req, res) => res.render('index'));
app.get('/whoweare', (_req, res) => res.redirect(301, '/'));
app.get('/customer', (_req, res) => res.render('customer'));
app.get('/it', (_req, res) => res.render('it'));
app.get('/contact', (_req, res) => res.render('contact'));

app.post('/contact', (req, res) => {
    const b = req.body || {};
    if (b.website && b.website.trim()) return res.redirect('/contact?sent=1');
    const name = (b.name || '').trim();
    const email = (b.email || '').trim();
    const message = (b.message || '').trim();
    const phone = (b.phone || '').trim().slice(0, 40);
    const subject = (b.subject || '').trim().slice(0, 200);
    if (!name || name.length > 100 || !email || email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message || message.length > 5000) {
        return res.redirect('/contact?error=invalid');
    }
    const messages = readMessages();
    messages.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name: name.slice(0, 100),
        email,
        phone,
        subject,
        message: message.slice(0, 5000),
        ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
        userAgent: (req.headers['user-agent'] || '').slice(0, 200),
        read: false,
        createdAt: new Date().toISOString()
    });
    writeMessages(messages);

    const notifyBody = `*New Contact — Ozawa Traders*\n\n` +
        `Name: ${name}\n` +
        `Email: ${email}\n` +
        (phone ? `Phone: ${phone}\n` : '') +
        (subject ? `Subject: ${subject}\n` : '') +
        `\nMessage:\n${message}`;
    sendWhatsApp(notifyBody);
    sendEmail({
        subject: subject ? `[Ozawa Traders] ${subject}` : '[Ozawa Traders] New contact form message',
        text: notifyBody + `\n\n---\nSubmitted: ${new Date().toLocaleString()}\nIP: ${(req.headers['x-forwarded-for'] || req.ip || '').toString()}`,
        replyTo: email
    });

    res.redirect('/contact?sent=1');
});
app.get('/rad', (_req, res) => res.render('category', { categoryKey: 'rad' }));
app.get('/card', (_req, res) => res.render('category', { categoryKey: 'card' }));
app.get('/physio', (_req, res) => res.render('category', { categoryKey: 'physio' }));
app.get('/ambu', (_req, res) => res.render('category', { categoryKey: 'ambu' }));
app.get('/power-cabinet', (_req, res) => res.render('category', { categoryKey: 'power-cabinet' }));
app.get('/matismart-breaker', (_req, res) => res.render('category', { categoryKey: 'matismart-breaker' }));
app.get('/earth-resistance-tester', (_req, res) => res.render('category', { categoryKey: 'earth-resistance-tester' }));
app.get('/micro-feeder', (_req, res) => res.render('category', { categoryKey: 'micro-feeder' }));
app.get('/dilution-tank', (_req, res) => res.render('category', { categoryKey: 'dilution-tank' }));

// Old category URLs → 301 redirect to new ones (SEO preserve)
app.get('/power', (_req, res) => res.redirect(301, '/matismart-breaker'));
app.get('/manufacturing', (_req, res) => res.redirect(301, '/micro-feeder'));
app.get('/duoyi', (_req, res) => res.redirect(301, '/earth-resistance-tester'));

// Legacy .html paths → redirect to clean URLs
const legacy = { 'index.html': '/', 'whoweare.html': '/', 'customer.html': '/customer', 'contact.html': '/contact', 'rad.html': '/rad', 'card.html': '/card', 'physio.html': '/physio', 'ambu.html': '/ambu', 'power.html': '/matismart-breaker', 'manufacturing.html': '/micro-feeder', 'duoyi.html': '/earth-resistance-tester' };
Object.entries(legacy).forEach(([from, to]) => app.get('/' + from, (_req, res) => res.redirect(301, to)));

// ----- Admin auth -----
const loginLimiter = rateLimit ? rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    skipSuccessfulRequests: true
}) : (_req, _res, next) => next();

app.get('/admin/login', (req, res) => {
    if (req.session.user) return res.redirect('/admin');
    res.render('admin/login', { error: null });
});

app.post('/admin/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    const auth = readAuth();
    if (username !== auth.username || !bcrypt.compareSync(password || '', auth.passwordHash)) {
        return res.render('admin/login', { error: 'Invalid credentials' });
    }
    req.session.user = { username: auth.username };
    res.redirect('/admin');
});

app.post('/admin/logout', requireAuth, (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

// ----- Admin dashboard -----
app.get('/admin', requireAuth, (_req, res) => res.render('admin/dashboard'));

// ----- Edit Home page -----
app.get('/admin/home', requireAuth, (_req, res) => res.render('admin/edit-home'));

app.post('/admin/home', requireAuth, upload.fields([
    { name: 'about_image_1', maxCount: 1 },
    { name: 'about_image_2', maxCount: 1 }
]), (req, res) => {
    const data = readContent();
    const f = req.files || {};
    const b = req.body;

    data.site.phone = b.site_phone || data.site.phone;
    data.site.email = b.site_email || data.site.email;
    data.site.tagline = b.site_tagline || data.site.tagline;
    data.site.trusted_since = b.site_trusted_since || data.site.trusted_since;

    data.home.hero.title_pre = b.hero_title_pre || '';
    data.home.hero.title_highlight = b.hero_title_highlight || '';
    data.home.hero.title_post = b.hero_title_post || '';
    data.home.hero.description = b.hero_description || '';
    data.home.hero.cta_primary_text = b.hero_cta_primary_text || '';
    data.home.hero.cta_primary_href = b.hero_cta_primary_href || '#';
    data.home.hero.cta_secondary_text = b.hero_cta_secondary_text || '';
    data.home.hero.cta_secondary_href = b.hero_cta_secondary_href || '#';
    const _statKeys = Object.keys(b).filter(k => /^stats_value_\d+$/.test(k)).map(k => parseInt(k.replace('stats_value_', ''), 10)).sort((a, b) => a - b);
    data.home.stats = _statKeys.map(i => ({
        value: b[`stats_value_${i}`] || '',
        suffix: b[`stats_suffix_${i}`] || '',
        label: b[`stats_label_${i}`] || ''
    }));

    data.home.about.subtitle = b.about_subtitle || '';
    data.home.about.title_pre = b.about_title_pre || '';
    data.home.about.title_highlight = b.about_title_highlight || '';
    data.home.about.paragraph_1 = b.about_paragraph_1 || '';
    data.home.about.paragraph_2 = b.about_paragraph_2 || '';
    data.home.about.quote = b.about_quote || '';
    data.home.about.features = [0, 1, 2, 3].map(i => ({
        title: b[`about_feature_title_${i}`] || '',
        description: b[`about_feature_desc_${i}`] || ''
    }));
    if (f.about_image_1) data.home.about.image_1 = '/img/uploads/' + f.about_image_1[0].filename;
    if (f.about_image_2) data.home.about.image_2 = '/img/uploads/' + f.about_image_2[0].filename;

    data.home.products_section.enabled = b.products_enabled === 'on' || b.products_enabled === 'true' || b.products_enabled === '1';
    data.home.products_section.subtitle = b.products_subtitle || '';
    data.home.products_section.title = b.products_title || '';
    data.home.products_section.description = b.products_description || '';

    data.home.why_us.subtitle = b.why_subtitle || '';
    data.home.why_us.title = b.why_title || '';
    data.home.why_us.description = b.why_description || '';
    data.home.why_us.items = [0, 1, 2].map(i => ({
        title: b[`why_item_title_${i}`] || '',
        description: b[`why_item_desc_${i}`] || ''
    }));

    data.home.cta.title = b.cta_title || '';
    data.home.cta.description = b.cta_description || '';
    data.home.cta.primary_text = b.cta_primary_text || '';
    data.home.cta.primary_href = b.cta_primary_href || '#';
    data.home.cta.secondary_text = b.cta_secondary_text || '';
    data.home.cta.secondary_href = b.cta_secondary_href || '#';

    data.footer.description = b.footer_description || '';
    data.footer.address = b.footer_address || '';
    data.footer.copyright = b.footer_copyright || '';

    writeContent(data);
    flash(req, 'success', 'Home page updated successfully.');
    res.redirect('/admin/home');
});

// ----- Hero slider images -----
app.post('/admin/home/slides/add', requireAuth, upload.single('slide'), (req, res) => {
    if (!req.file) {
        flash(req, 'error', 'Please choose an image file.');
        return res.redirect('/admin/home');
    }
    const data = readContent();
    if (!data.home.hero.slides) data.home.hero.slides = [];
    data.home.hero.slides.push('/img/uploads/' + req.file.filename);
    writeContent(data);
    flash(req, 'success', 'Banner image added.');
    res.redirect('/admin/home');
});

app.post('/admin/home/slides/replace', requireAuth, upload.single('slide'), (req, res) => {
    const data = readContent();
    const idx = parseInt(req.body.index, 10);
    if (!req.file || Number.isNaN(idx) || !data.home.hero.slides || !data.home.hero.slides[idx]) {
        flash(req, 'error', 'Invalid replace request.');
        return res.redirect('/admin/home');
    }
    data.home.hero.slides[idx] = '/img/uploads/' + req.file.filename;
    writeContent(data);
    flash(req, 'success', 'Banner image replaced.');
    res.redirect('/admin/home');
});

app.post('/admin/home/slides/delete', requireAuth, (req, res) => {
    const data = readContent();
    const idx = parseInt(req.body.index, 10);
    if (!Number.isNaN(idx) && data.home.hero.slides && data.home.hero.slides[idx]) {
        data.home.hero.slides.splice(idx, 1);
        writeContent(data);
        flash(req, 'success', 'Banner image removed.');
    }
    res.redirect('/admin/home');
});

app.post('/admin/home/slides/move', requireAuth, (req, res) => {
    const data = readContent();
    const idx = parseInt(req.body.index, 10);
    const dir = req.body.dir === 'up' ? -1 : 1;
    const slides = data.home.hero.slides || [];
    const target = idx + dir;
    if (!Number.isNaN(idx) && slides[idx] && target >= 0 && target < slides.length) {
        [slides[idx], slides[target]] = [slides[target], slides[idx]];
        writeContent(data);
    }
    res.redirect('/admin/home');
});

// ----- Products CRUD -----
app.get('/admin/products', requireAuth, (_req, res) => res.render('admin/products'));

app.post('/admin/products/add', requireAuth, upload.single('icon'), (req, res) => {
    const data = readContent();
    const id = (req.body.id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || `p${Date.now()}`;
    if (data.products.some(p => p.id === id)) {
        flash(req, 'error', `Product id "${id}" already exists.`);
        return res.redirect('/admin/products');
    }
    data.products.push({
        id,
        title: req.body.title || 'Untitled',
        description: req.body.description || '',
        icon: req.file ? '/img/uploads/' + req.file.filename : '/img/it.png',
        href: req.body.href || '#'
    });
    writeContent(data);
    flash(req, 'success', 'Product added.');
    res.redirect('/admin/products');
});

app.post('/admin/products/:id/edit', requireAuth, upload.single('icon'), (req, res) => {
    const data = readContent();
    const p = data.products.find(x => x.id === req.params.id);
    if (!p) return res.redirect('/admin/products');
    p.title = req.body.title || p.title;
    p.description = req.body.description || p.description;
    p.href = req.body.href || p.href;
    if (req.file) p.icon = '/img/uploads/' + req.file.filename;
    writeContent(data);
    flash(req, 'success', 'Product updated.');
    res.redirect('/admin/products');
});

app.post('/admin/products/:id/delete', requireAuth, (req, res) => {
    const data = readContent();
    data.products = data.products.filter(x => x.id !== req.params.id);
    writeContent(data);
    flash(req, 'success', 'Product deleted.');
    res.redirect('/admin/products');
});

app.post('/admin/products/reorder', requireAuth, (req, res) => {
    const data = readContent();
    const order = (req.body.order || '').split(',').filter(Boolean);
    if (order.length) {
        const map = Object.fromEntries(data.products.map(p => [p.id, p]));
        data.products = order.map(id => map[id]).filter(Boolean).concat(data.products.filter(p => !order.includes(p.id)));
        writeContent(data);
    }
    res.json({ ok: true });
});

// ----- Certificates (homepage carousel) -----
app.get('/admin/certificates', requireAuth, (_req, res) => res.render('admin/certificates'));

app.post('/admin/certificates/add', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) {
        flash(req, 'error', 'Please choose an image file.');
        return res.redirect('/admin/certificates');
    }
    const data = readContent();
    if (!Array.isArray(data.home.certificates)) data.home.certificates = [];
    const id = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    data.home.certificates.push({
        id,
        image: '/img/uploads/' + req.file.filename,
        title: (req.body.title || '').trim(),
        subtitle: (req.body.subtitle || '').trim(),
        year: (req.body.year || '').trim()
    });
    writeContent(data);
    flash(req, 'success', 'Certificate added.');
    res.redirect('/admin/certificates');
});

app.post('/admin/certificates/:id/edit', requireAuth, upload.single('image'), (req, res) => {
    const data = readContent();
    if (!Array.isArray(data.home.certificates)) data.home.certificates = [];
    const c = data.home.certificates.find(x => x.id === req.params.id);
    if (!c) { flash(req, 'error', 'Certificate not found.'); return res.redirect('/admin/certificates'); }
    c.title = (req.body.title || '').trim();
    c.subtitle = (req.body.subtitle || '').trim();
    c.year = (req.body.year || '').trim();
    if (req.file) c.image = '/img/uploads/' + req.file.filename;
    writeContent(data);
    flash(req, 'success', 'Certificate updated.');
    res.redirect('/admin/certificates');
});

app.post('/admin/certificates/:id/delete', requireAuth, (req, res) => {
    const data = readContent();
    if (!Array.isArray(data.home.certificates)) data.home.certificates = [];
    data.home.certificates = data.home.certificates.filter(x => x.id !== req.params.id);
    writeContent(data);
    flash(req, 'success', 'Certificate removed.');
    res.redirect('/admin/certificates');
});

app.post('/admin/certificates/reorder', requireAuth, (req, res) => {
    const data = readContent();
    const order = (req.body.order || '').split(',').filter(Boolean);
    if (order.length && Array.isArray(data.home.certificates)) {
        const map = Object.fromEntries(data.home.certificates.map(c => [c.id, c]));
        data.home.certificates = order.map(id => map[id]).filter(Boolean).concat(data.home.certificates.filter(c => !order.includes(c.id)));
        writeContent(data);
    }
    res.json({ ok: true });
});

// ----- Customers logos -----
app.get('/admin/customers', requireAuth, (_req, res) => res.render('admin/customers'));

app.post('/admin/customers/text', requireAuth, (req, res) => {
    const data = readContent();
    const b = req.body;
    data.customers.hero_title = b.hero_title || '';
    data.customers.hero_subtitle = b.hero_subtitle || '';

    // Parse indexed list inputs: lists_0_title / lists_0_items, lists_1_title / lists_1_items, ...
    const idxs = Object.keys(b)
        .filter(k => /^lists_\d+_title$/.test(k))
        .map(k => parseInt(k.replace(/^lists_/, '').replace(/_title$/, ''), 10))
        .sort((a, b) => a - b);
    const lists = idxs.map(i => ({
        subtitle: (b[`lists_${i}_subtitle`] || '').trim(),
        title: (b[`lists_${i}_title`] || '').trim(),
        items: (b[`lists_${i}_items`] || '')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean)
    })).filter(l => l.title || l.items.length);
    data.customers.lists = lists;

    // Clean up old fields if present
    if ('list_title' in data.customers) delete data.customers.list_title;
    if ('list_items' in data.customers) delete data.customers.list_items;

    writeContent(data);
    flash(req, 'success', 'Customers section updated.');
    res.redirect('/admin/customers');
});

app.post('/admin/customers/add', requireAuth, upload.single('logo'), (req, res) => {
    if (!req.file) {
        flash(req, 'error', 'Please choose an image file.');
        return res.redirect('/admin/customers');
    }
    const data = readContent();
    data.customers.logos.push('/img/uploads/' + req.file.filename);
    writeContent(data);
    flash(req, 'success', 'Customer logo added.');
    res.redirect('/admin/customers');
});

app.post('/admin/customers/delete', requireAuth, (req, res) => {
    const data = readContent();
    data.customers.logos = data.customers.logos.filter(x => x !== req.body.path);
    writeContent(data);
    flash(req, 'success', 'Logo removed.');
    res.redirect('/admin/customers');
});

// ----- Site Settings -----
app.get('/admin/site', requireAuth, (_req, res) => {
    res.render('admin/site-settings', { maintenanceOn: process.env.MAINTENANCE === 'true' });
});

app.post('/admin/site/info', requireAuth, (req, res) => {
    const data = readContent();
    data.site.name = req.body.name || '';
    data.site.phone = req.body.phone || '';
    data.site.email = req.body.email || '';
    data.site.tagline = req.body.tagline || '';
    data.site.trusted_since = req.body.trusted_since || '';
    data.site.iso_certified = !!req.body.iso_certified;
    data.site.meta_subtitle = req.body.meta_subtitle || '';
    data.site.meta_description = req.body.meta_description || '';
    data.site.meta_keywords = req.body.meta_keywords || '';
    writeContent(data);
    flash(req, 'success', 'Site info updated.');
    res.redirect('/admin/site');
});

app.post('/admin/site/footer', requireAuth, (req, res) => {
    const data = readContent();
    const b = req.body;
    data.footer.description = b.description || '';
    data.footer.address = b.address || '';
    data.footer.copyright = b.copyright || '';
    data.footer.credit_name = b.credit_name || '';
    data.footer.credit_link = b.credit_link || '';

    // Parse indexed column inputs: cols_0_title / cols_0_links, cols_1_title / cols_1_links, ...
    const idxs = Object.keys(b)
        .filter(k => /^cols_\d+_title$/.test(k))
        .map(k => parseInt(k.replace(/^cols_/, '').replace(/_title$/, ''), 10))
        .sort((a, b) => a - b);
    const columns = idxs.map(i => {
        const title = (b[`cols_${i}_title`] || '').trim();
        const linkLines = (b[`cols_${i}_links`] || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const links = linkLines.map(line => {
            const parts = line.split('|').map(p => p.trim());
            return { label: parts[0] || '', href: parts[1] || '#' };
        }).filter(l => l.label);
        return { title, links };
    }).filter(c => c.title || c.links.length);
    data.footer.columns = columns;

    writeContent(data);
    flash(req, 'success', 'Footer updated.');
    res.redirect('/admin/site');
});

app.post('/admin/site/maintenance', requireAuth, (req, res) => {
    const target = req.body.value === 'true' ? 'true' : 'false';
    const envPath = ENV_FILE;
    let env = '';
    try { env = fs.readFileSync(envPath, 'utf8'); } catch {}
    if (/^MAINTENANCE=/m.test(env)) {
        env = env.replace(/^MAINTENANCE=.*$/m, 'MAINTENANCE=' + target);
    } else {
        env += (env && !env.endsWith('\n') ? '\n' : '') + 'MAINTENANCE=' + target + '\n';
    }
    fs.writeFileSync(envPath, env, 'utf8');
    process.env.MAINTENANCE = target;
    flash(req, 'success', 'Maintenance mode set to ' + target.toUpperCase() + '. (Restart pm2 for full effect.)');
    res.redirect('/admin/site');
});

// ----- Contact -----
app.get('/admin/contact', requireAuth, (_req, res) => res.render('admin/contact'));

app.post('/admin/contact', requireAuth, (req, res) => {
    const data = readContent();
    data.contact.hero_title = req.body.hero_title || '';
    data.contact.hero_subtitle = req.body.hero_subtitle || '';
    data.contact.address = req.body.address || '';
    data.contact.phone = req.body.phone || '';
    data.contact.email = req.body.email || '';
    data.contact.hours = req.body.hours || '';
    data.contact.map_address = req.body.map_address || '';
    data.contact.map_embed_url = req.body.map_embed_url || '';
    writeContent(data);
    flash(req, 'success', 'Contact info updated.');
    res.redirect('/admin/contact');
});

// ----- IT / Software section -----
app.get('/admin/it', requireAuth, (_req, res) => res.render('admin/edit-it'));

app.post('/admin/it', requireAuth, (req, res) => {
    const data = readContent();
    const b = req.body;
    if (!data.it) data.it = {};
    data.it.hero_badge = b.hero_badge || '';
    data.it.hero_title = b.hero_title || '';
    data.it.hero_subtitle = b.hero_subtitle || '';
    data.it.intro_title = b.intro_title || '';
    data.it.intro_paragraph = b.intro_paragraph || '';
    data.it.services_subtitle = b.services_subtitle || '';
    data.it.services_title = b.services_title || '';
    data.it.services_description = b.services_description || '';

    // Services: one per line as "Title | Description"
    data.it.services = (b.services || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const parts = line.split('|').map(p => p.trim());
            return { title: parts[0] || '', description: parts[1] || '' };
        })
        .filter(s => s.title);

    if (!data.it.tenders) data.it.tenders = {};
    data.it.tenders.subtitle = b.tenders_subtitle || '';
    data.it.tenders.title = b.tenders_title || '';
    data.it.tenders.description = b.tenders_description || '';
    data.it.tenders.cta_text = b.tenders_cta_text || '';
    data.it.tenders.cta_href = b.tenders_cta_href || '';
    data.it.tenders.points = (b.tenders_points || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);

    data.it.tenders.filter_hint = b.tenders_filter_hint || '';
    data.it.tenders.listings_title = b.tenders_listings_title || '';
    data.it.tenders.listings_note = b.tenders_listings_note || '';
    data.it.tenders.live_text = b.tenders_live_text || '';
    data.it.tenders.live_href = b.tenders_live_href || '';

    // Tender listings: one per line as "Title | Department | Ref | Category | Date | URL"
    data.it.tenders.listings = (b.tenders_listings || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const p = line.split('|').map(x => x.trim());
            return { title: p[0] || '', department: p[1] || '', ref: p[2] || '', category: p[3] || '', date: p[4] || '', url: p[5] || '' };
        })
        .filter(x => x.title);

    writeContent(data);
    flash(req, 'success', 'IT section updated.');
    res.redirect('/admin/it');
});

// ----- Categories (rad/card/physio/ambu/power) -----
app.get('/admin/category/:key', requireAuth, (req, res) => {
    if (!res.locals.content.categories[req.params.key]) return res.redirect('/admin');
    res.render('admin/category', { categoryKey: req.params.key });
});

app.post('/admin/category/:key/text', requireAuth, (req, res) => {
    const data = readContent();
    const k = req.params.key;
    if (!data.categories[k]) return res.redirect('/admin');
    data.categories[k].title = req.body.title || '';
    data.categories[k].description = req.body.description || '';
    const mode = (req.body.display_mode || '').trim();
    if (mode === 'slider') {
        data.categories[k].display_mode = 'slider';
    } else if ('display_mode' in data.categories[k]) {
        delete data.categories[k].display_mode;
    }
    writeContent(data);
    flash(req, 'success', 'Category updated.');
    res.redirect('/admin/category/' + k);
});

app.post('/admin/category/:key/add', requireAuth, upload.single('photo'), (req, res) => {
    if (!req.file) {
        flash(req, 'error', 'Please choose an image file.');
        return res.redirect('/admin/category/' + req.params.key);
    }
    const data = readContent();
    const k = req.params.key;
    if (!data.categories[k]) return res.redirect('/admin');
    data.categories[k].gallery.push('/img/uploads/' + req.file.filename);
    writeContent(data);
    flash(req, 'success', 'Photo added.');
    res.redirect('/admin/category/' + k);
});

app.post('/admin/category/:key/delete', requireAuth, (req, res) => {
    const data = readContent();
    const k = req.params.key;
    if (!data.categories[k]) return res.redirect('/admin');
    data.categories[k].gallery = data.categories[k].gallery.filter(x => x !== req.body.path);
    writeContent(data);
    flash(req, 'success', 'Photo removed.');
    res.redirect('/admin/category/' + k);
});

// ----- Category Products CRUD (structured product cards: image, title, tagline, summary, highlights) -----
function parseHighlights(raw) {
    return (raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

app.post('/admin/category/:key/product/add', requireAuth, upload.single('image'), (req, res) => {
    const data = readContent();
    const k = req.params.key;
    if (!data.categories[k]) return res.redirect('/admin');
    if (!Array.isArray(data.categories[k].products)) data.categories[k].products = [];
    const id = (req.body.id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || `p${Date.now()}`;
    if (data.categories[k].products.some(p => p.id === id)) {
        flash(req, 'error', `Product id "${id}" already exists in this category.`);
        return res.redirect('/admin/category/' + k);
    }
    data.categories[k].products.push({
        id,
        title: req.body.title || 'Untitled',
        tagline: req.body.tagline || '',
        image: req.file ? '/img/uploads/' + req.file.filename : (req.body.image_path || ''),
        summary: req.body.summary || '',
        highlights: parseHighlights(req.body.highlights)
    });
    writeContent(data);
    flash(req, 'success', 'Product added.');
    res.redirect('/admin/category/' + k);
});

app.post('/admin/category/:key/product/:id/edit', requireAuth, upload.single('image'), (req, res) => {
    const data = readContent();
    const k = req.params.key;
    if (!data.categories[k] || !Array.isArray(data.categories[k].products)) return res.redirect('/admin');
    const p = data.categories[k].products.find(x => x.id === req.params.id);
    if (!p) {
        flash(req, 'error', 'Product not found.');
        return res.redirect('/admin/category/' + k);
    }
    p.title = req.body.title || p.title;
    p.tagline = req.body.tagline !== undefined ? req.body.tagline : p.tagline;
    p.summary = req.body.summary !== undefined ? req.body.summary : p.summary;
    if (req.body.highlights !== undefined) p.highlights = parseHighlights(req.body.highlights);
    if (req.file) p.image = '/img/uploads/' + req.file.filename;
    else if (req.body.image_path) p.image = req.body.image_path;
    writeContent(data);
    flash(req, 'success', 'Product updated.');
    res.redirect('/admin/category/' + k);
});

app.post('/admin/category/:key/product/:id/delete', requireAuth, (req, res) => {
    const data = readContent();
    const k = req.params.key;
    if (!data.categories[k] || !Array.isArray(data.categories[k].products)) return res.redirect('/admin');
    data.categories[k].products = data.categories[k].products.filter(x => x.id !== req.params.id);
    writeContent(data);
    flash(req, 'success', 'Product removed.');
    res.redirect('/admin/category/' + k);
});

// ----- Messages (contact form submissions) -----
app.get('/admin/messages', requireAuth, (_req, res) => {
    const messages = readMessages();
    res.render('admin/messages', { messages });
});

app.post('/admin/messages/:id/read', requireAuth, (req, res) => {
    const messages = readMessages();
    const m = messages.find(x => x.id === req.params.id);
    if (m) { m.read = !m.read; writeMessages(messages); }
    res.redirect('/admin/messages');
});

app.post('/admin/messages/:id/delete', requireAuth, (req, res) => {
    const messages = readMessages().filter(x => x.id !== req.params.id);
    writeMessages(messages);
    flash(req, 'success', 'Message deleted.');
    res.redirect('/admin/messages');
});

// ----- Settings (change password, replace logo) -----
app.get('/admin/settings', requireAuth, (_req, res) => res.render('admin/settings', { error: null, success: null }));

app.post('/admin/settings/password', requireAuth, (req, res) => {
    const auth = readAuth();
    if (!bcrypt.compareSync(req.body.current || '', auth.passwordHash)) {
        return res.render('admin/settings', { error: 'Current password incorrect', success: null });
    }
    if (!req.body.next || req.body.next.length < 6) {
        return res.render('admin/settings', { error: 'New password must be at least 6 characters', success: null });
    }
    auth.passwordHash = bcrypt.hashSync(req.body.next, 10);
    writeAuth(auth);
    res.render('admin/settings', { error: null, success: 'Password changed.' });
});

app.post('/admin/settings/logo', requireAuth, upload.single('logo'), (req, res) => {
    if (!req.file) {
        flash(req, 'error', 'Please choose an image file.');
        return res.redirect('/admin/settings');
    }
    const data = readContent();
    data.site.logo = '/img/uploads/' + req.file.filename;
    writeContent(data);
    flash(req, 'success', 'Logo updated.');
    res.redirect('/admin/settings');
});

// ----- 404 fallback -----
app.use((req, res) => {
    res.status(404).render('404', { pageTitle: 'Page Not Found — ' + (readContent().site.name || 'Ozawa Traders') });
});

// ----- Errors -----
app.use((err, _req, res, _next) => {
    console.error(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).send('File too large. Maximum upload size is 10MB.');
    }
    res.status(500).send('Server error: ' + err.message);
});

// On Vercel the app runs as a serverless function — export it instead of listening.
if (process.env.VERCEL) {
    module.exports = app;
} else {
    app.listen(PORT, () => {
        console.log(`Ozawa Traders site running at http://localhost:${PORT}`);
        console.log(`Admin panel: http://localhost:${PORT}/admin/login`);
    });
}
