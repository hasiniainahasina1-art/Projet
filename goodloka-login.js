// goodloka-login-simple.js – Auto-login GoodLoka (sans chiffrement, sans proxy)
const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------- Variables d'environnement ----------
const phone    = process.env.PHONE;
const password = process.env.PASSWORD;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

const USER_FILE = `goodloka_${phone.replace(/[^a-zA-Z0-9]/g, '_')}.json`;

const videosDir = path.join(__dirname, 'videos');
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1) + min));

// --- Fonctions d'interaction humaine ---
async function fillFieldHuman(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage de ${fieldName}...`);
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
        try {
            await page.waitForSelector(selector, { visible: true, timeout: 10000 });
            break;
        } catch (e) {
            attempts++;
            if (attempts >= maxAttempts) throw new Error(`Impossible de trouver le champ ${fieldName}`);
            console.log(`⚠️ Champ ${fieldName} pas encore visible, tentative ${attempts}/${maxAttempts}`);
        }
    }
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await randomDelay(100, 200);
    for (const char of value) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
    }
    await randomDelay(200, 500);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        console.warn(`⚠️ Correction du champ ${fieldName}`);
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: Math.floor(Math.random() * 50) + 40 });
    }
}

async function humanClickAt(page, coords) {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y);
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
}

// --- Sauvegarde (sans chiffrement) ---
async function saveAccount(accountData) {
    const octokit = new Octokit({ auth: GH_TOKEN });
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let sha = null;
            try {
                const res = await octokit.repos.getContent({
                    owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
                });
                sha = res.data.sha;
            } catch (e) {}
            const content = Buffer.from(JSON.stringify(accountData, null, 2)).toString('base64');
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE,
                message: `Login GoodLoka ${phone}`,
                content, branch: GH_BRANCH, sha
            });
            console.log(`💾 Compte sauvegardé dans ${USER_FILE}`);
            return;
        } catch (err) {
            if (err.status === 409 && attempt < maxRetries) {
                console.warn(`⚠️ Conflit 409, tentative ${attempt}/${maxRetries}`);
                await delay(1000 * attempt);
            } else throw err;
        }
    }
}

// --- Capture vidéo ---
function startFFmpeg(videoPath) {
    const display = process.env.DISPLAY || ':99';
    const args = [
        '-f', 'x11grab',
        '-video_size', '1280x720',
        '-i', display,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '0',
        '-pix_fmt', 'yuv420p',
        '-y',
        videoPath
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
    console.log(`🎥 FFmpeg démarré sur ${display} → ${videoPath}`);
    return ffmpeg;
}
function stopFFmpeg(ffmpeg) {
    return new Promise((resolve) => {
        ffmpeg.on('close', resolve);
        ffmpeg.kill('SIGINT');
    });
}

// --- Main ---
(async () => {
    const videoPath = path.join(videosDir, `goodloka_login_${phone.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    let ffmpegProcess, browser;
    try {
        // Connexion sans proxy (directe)
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: ['--no-sandbox']
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        ffmpegProcess = startFFmpeg(videoPath);
        await delay(1000);

        // 1. Aller sur la page de login
        const loginUrl = 'https://www.goodloka.com/auth/login';
        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        // 2. Remplir les champs
        await fillFieldHuman(page, 'input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="Phone" i]', phone, 'téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'mot de passe');
        await randomDelay(500, 1500);

        // 3. Clic sur le bouton de connexion
        console.log('🔍 Recherche du bouton de connexion...');
        const loginBtnCoords = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => /login|connexion|sign in/i.test(b.textContent));
            if (!loginBtn) return null;
            const rect = loginBtn.getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        });
        if (loginBtnCoords) {
            await humanClickAt(page, loginBtnCoords);
            console.log('🖱️ Clic sur le bouton de connexion');
        } else {
            console.log('⚠️ Bouton non trouvé, appui sur Entrée');
            await page.keyboard.press('Enter');
        }
        await delay(5000);

        // 4. Vérifier que l'on n'est plus sur la page de login
        const currentUrl = page.url();
        if (currentUrl.includes('login')) {
            throw new Error('Échec de connexion (toujours sur la page login)');
        }
        console.log('✅ Connexion réussie');

        // 5. Récupérer les cookies
        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        await stopFFmpeg(ffmpegProcess);
        await browser.close();

        // 6. Sauvegarde du compte (en clair)
        const account = {
            phone,
            password,          // ⚠️ stocké en clair (pas de chiffrement)
            cookies,
            cookiesStatus: 'valid',
            lastLogin: Date.now()
        };
        await saveAccount(account);

        console.log('🎉 Script terminé avec succès.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (ffmpegProcess) await stopFFmpeg(ffmpegProcess);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
