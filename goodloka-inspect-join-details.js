// goodloka-inspect-join-details.js – Login, aller sur la page domino, extraire les détails de la partie adverse
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
    // On cherche le conteneur qui englobe le bouton "Rejoindre" et tous les détails
    return await page.evaluate(() => {
        const joinBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Rejoindre');
        if (!joinBtn) return null;

        // Remonter au conteneur parent le plus proche qui contient les infos (mise, score…)
        let container = joinBtn.closest('.game-card, .match-item, .room-item, .table-row, li, div[class*="game"], div[class*="match"], div[class*="room"]');
        if (!container) {
            // Fallback : remonter de 2 ou 3 niveaux
            container = joinBtn.parentElement?.parentElement?.parentElement;
        }
        if (!container) return null;

        // Récupérer tout le texte visible du conteneur
        const fullText = container.textContent.replace(/\s+/g, ' ').trim();
        return fullText;
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

        // 2. Aller sur la liste des jeux et cliquer sur le premier "Jouer"
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        console.log('🔍 Recherche du premier lien "Jouer"...');
        const clicked = await page.evaluate(() => {
            const links = [...document.querySelectorAll('a')];
            const jouerLink = links.find(a => a.textContent.trim() === 'Jouer');
            if (jouerLink) {
                jouerLink.click();
                return true;
            }
            return false;
        });
        if (!clicked) {
            const parentClicked = await page.evaluate(() => {
                const links = [...document.querySelectorAll('a')];
                const jouerLink = links.find(a => a.textContent.trim() === 'Jouer');
                if (jouerLink && jouerLink.parentElement) {
                    jouerLink.parentElement.click();
                    return true;
                }
                return false;
            });
            if (!parentClicked) throw new Error('Impossible de cliquer sur Jouer');
        }
        await delay(5000);
        console.log(`📍 URL après clic sur Jouer : ${page.url()}`);

        // 3. Prendre une capture de la page avant extraction
        await page.screenshot({ path: path.join(screenshotsDir, 'domino_before_extract.png'), fullPage: true });

        // 4. Chercher le bouton "Rejoindre" et extraire les conditions
        const joinBtn = await page.$('button:has-text("Rejoindre")');
        if (!joinBtn) {
            console.log('⚠️ Aucun bouton "Rejoindre" trouvé. Capture de la page actuelle.');
            await page.screenshot({ path: path.join(screenshotsDir, 'no_join_button.png'), fullPage: true });
        } else {
            const conditions = await extractGameConditions(page);
            if (conditions) {
                console.log('📋 Conditions de la partie adverse :');
                console.log(conditions);
            } else {
                console.log('⚠️ Impossible d\'extraire les conditions. Voici les textes visibles autour du bouton :');
                // Extraire le texte du parent immédiat
                const parentText = await joinBtn.evaluate(el => el.parentElement?.textContent?.trim() || '');
                console.log(parentText);
            }

            // Optionnel : cliquer sur "Rejoindre" pour voir la modale et capturer plus d'infos
            console.log('🖱️ Clic sur "Rejoindre" pour voir les détails supplémentaires...');
            await joinBtn.click();
            await delay(3000);
            await page.screenshot({ path: path.join(screenshotsDir, 'after_join_click.png'), fullPage: true });

            // Afficher les nouveaux textes apparus (ex: message de solde insuffisant)
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
