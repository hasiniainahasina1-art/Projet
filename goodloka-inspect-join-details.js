// goodloka-inspect-join-details.js – Login, clic sécurisé sur "Jouer", extraction des conditions
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

// --- Extraction des conditions de la partie adverse ---
async function extractGameConditions(page) {
    return await page.evaluate(() => {
        const joinBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Rejoindre');
        if (!joinBtn) return null;

        let container = joinBtn.closest('.game-card, .match-item, .room-item, .table-row, li, div[class*="game"], div[class*="match"], div[class*="room"]');
        if (!container) {
            container = joinBtn.parentElement?.parentElement?.parentElement;
        }
        if (!container) return null;

        return container.textContent.replace(/\s+/g, ' ').trim();
    });
}

(async () => {
    const videoPath = path.join(videosDir, `goodloka_join_details_${phone.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    let ffmpegProcess, browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: [
                '--no-sandbox',
                '--disable-save-password-bubble',
                '--disable-features=PasswordManager'
            ]
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        ffmpegProcess = startFFmpeg(videoPath);
        await delay(1000);

        // 1. Login
        const loginUrl = 'https://www.goodloka.com/auth/login';
        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        await fillFieldHuman(page, 'input[type="text"][placeholder*="Ex"]', phone, 'téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'mot de passe');
        await randomDelay(500, 1500);

        console.log('⏎ Appui sur Entrée pour valider la connexion...');
        await page.keyboard.press('Enter');

        console.log('⏳ Attente de la redirection...');
        try {
            await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 30000 });
        } catch (e) { console.warn('⚠️ Redirection non détectée'); }
        await delay(5000);
        console.log(`📍 URL après connexion : ${page.url()}`);

        // 2. Aller sur la liste des jeux
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        console.log(`🎮 Navigation vers ${gamesListUrl}`);
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        // 3. Attendre qu'un lien "Jouer" soit visible et cliquer dessus
        console.log('⏳ Attente du premier lien "Jouer"...');
        try {
            // Attendre qu'au moins un lien "Jouer" apparaisse
            await page.waitForSelector('a', { visible: true, timeout: 15000 });
            // Chercher parmi tous les liens celui qui contient exactement "Jouer"
            const jouerLink = await page.evaluateHandle(() => {
                const links = [...document.querySelectorAll('a')];
                return links.find(a => a.textContent.trim() === 'Jouer' && a.offsetParent !== null);
            });
            if (jouerLink) {
                // Obtenir les coordonnées pour un clic humain
                const box = await jouerLink.boundingBox();
                if (box) {
                    const coords = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                    console.log(`🖱️ Clic sur "Jouer" à (${Math.round(coords.x)}, ${Math.round(coords.y)})`);
                    await humanClickAt(page, coords);
                } else {
                    // Fallback : clic direct via evaluate
                    await jouerLink.evaluate(el => el.click());
                }
            } else {
                // Dernier recours : cliquer sur le premier lien "Jouer" par JavaScript
                const clicked = await page.evaluate(() => {
                    const links = [...document.querySelectorAll('a')];
                    const jouer = links.find(a => a.textContent.trim() === 'Jouer');
                    if (jouer) { jouer.click(); return true; }
                    return false;
                });
                if (!clicked) throw new Error('Aucun lien "Jouer" trouvé');
            }
        } catch (err) {
            console.warn('⚠️ Impossible de cliquer sur "Jouer", capture de l\'état actuel...');
            await page.screenshot({ path: path.join(screenshotsDir, 'error_no_jouer.png'), fullPage: true });
            // Ne pas arrêter le script, on peut essayer d'aller directement sur domino si token connu
            // Pour l'instant on continue sans erreur fatale
        }
        await delay(5000);
        console.log(`📍 URL après clic sur Jouer : ${page.url()}`);

        // 4. Capture avant extraction
        await page.screenshot({ path: path.join(screenshotsDir, 'domino_before_extract.png'), fullPage: true });

        // 5. Chercher le bouton "Rejoindre" et extraire les conditions
        const joinBtn = await page.$('button:has-text("Rejoindre")');
        if (!joinBtn) {
            console.log('⚠️ Aucun bouton "Rejoindre" trouvé. Capture de la page.');
            await page.screenshot({ path: path.join(screenshotsDir, 'no_join_button.png'), fullPage: true });
        } else {
            const conditions = await extractGameConditions(page);
            if (conditions) {
                console.log('📋 Conditions de la partie adverse :');
                console.log(conditions);
            } else {
                console.log('⚠️ Impossible d\'extraire les conditions. Textes autour du bouton :');
                const parentText = await joinBtn.evaluate(el => el.parentElement?.textContent?.trim() || '');
                console.log(parentText);
            }

            // Clic sur "Rejoindre" pour voir la modale (même si solde insuffisant)
            console.log('🖱️ Clic sur "Rejoindre" pour inspecter la modale...');
            await joinBtn.click();
            await delay(3000);
            await page.screenshot({ path: path.join(screenshotsDir, 'after_join_click.png'), fullPage: true });

            const newTexts = await page.$$eval('*', els =>
                els
                    .filter(el => el.offsetParent !== null && el.textContent.trim().length > 0 && el.children.length === 0)
                    .map(el => el.textContent.trim().substring(0, 100))
                    .slice(0, 20)
            );
            console.log('📝 Textes après clic :');
            newTexts.forEach((t, i) => console.log(`  ${i+1}. "${t}"`));
        }

        await stopFFmpeg(ffmpegProcess);
        await browser.close();

        console.log('🎉 Inspection terminée avec succès.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (ffmpegProcess) await stopFFmpeg(ffmpegProcess);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
