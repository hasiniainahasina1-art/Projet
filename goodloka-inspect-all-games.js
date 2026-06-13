// goodloka-inspect-all-games.js – Extraction individuelle de chaque partie
const { connect } = require('puppeteer-real-browser');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
const videosDir = path.join(__dirname, 'videos');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1) + min));

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

function startFFmpeg(videoPath) {
    const display = process.env.DISPLAY || ':99';
    const args = ['-f','x11grab','-video_size','1280x720','-i',display,'-c:v','libx264','-preset','ultrafast','-crf','0','-pix_fmt','yuv420p','-y',videoPath];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
    console.log(`🎥 FFmpeg démarré sur ${display} → ${videoPath}`);
    return ffmpeg;
}
function stopFFmpeg(ffmpeg) {
    return new Promise((resolve) => { ffmpeg.on('close', resolve); ffmpeg.kill('SIGINT'); });
}

async function extractAllGamesConditions(page) {
    return await page.evaluate(() => {
        const games = [];
        const allButtons = [...document.querySelectorAll('button')];
        const joinBtns = allButtons.filter(b => b.textContent.trim() === 'Rejoindre');

        joinBtns.forEach((btn, index) => {
            let container = btn.parentElement;
            while (container) {
                const joinCount = [...container.querySelectorAll('button')]
                    .filter(b => b.textContent.trim() === 'Rejoindre').length;
                if (joinCount === 1) break;
                container = container.parentElement;
            }
            if (!container) {
                container = btn.parentElement;
            }
            const text = container.textContent.replace(/\s+/g, ' ').trim();
            games.push({ index: index + 1, text });
        });
        return games;
    });
}

(async () => {
    const videoPath = path.join(videosDir, `goodloka_all_games_${phone.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    let ffmpegProcess, browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: ['--no-sandbox', '--disable-save-password-bubble', '--disable-features=PasswordManager']
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        ffmpegProcess = startFFmpeg(videoPath);
        await delay(1000);

        // Login (inchangé) ...
        const loginUrl = 'https://www.goodloka.com/auth/login';
        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        await fillFieldHuman(page, 'input[type="text"][placeholder*="Ex"]', phone, 'téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'mot de passe');
        await randomDelay(500, 1500);
        console.log('⏎ Appui sur Entrée...');
        await page.keyboard.press('Enter');
        try { await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 30000 }); } catch (e) {}
        await delay(5000);
        console.log(`📍 Connecté : ${page.url()}`);

        // Aller sur la liste des jeux et cliquer sur "Jouer"
        await page.goto('https://www.goodloka.com/games/list', { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        console.log('🔍 Clic sur le premier "Jouer"...');
        const jouerHandle = await page.evaluateHandle(() => {
            const links = [...document.querySelectorAll('a')];
            return links.find(a => a.textContent.trim() === 'Jouer' && a.offsetParent !== null);
        });
        if (jouerHandle) {
            const box = await jouerHandle.boundingBox();
            if (box) await humanClickAt(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
            else await jouerHandle.evaluate(el => el.click());
            await jouerHandle.dispose();
        } else {
            console.log('⚠️ Aucun lien "Jouer" visible.');
        }
        await delay(5000);
        console.log(`📍 Page domino : ${page.url()}`);

        // Capture et extraction
        await page.screenshot({ path: path.join(screenshotsDir, 'domino_all_games.png'), fullPage: true });
        const games = await extractAllGamesConditions(page);
        if (games.length === 0) {
            console.log('⚠️ Aucune partie trouvée.');
        } else {
            console.log(`📋 ${games.length} partie(s) :`);
            games.forEach(g => {
                console.log(`\n--- Partie #${g.index} ---`);
                console.log(g.text);
            });
        }

        await stopFFmpeg(ffmpegProcess);
        await browser.close();
        console.log('🎉 Terminé.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (ffmpegProcess) await stopFFmpeg(ffmpegProcess);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
