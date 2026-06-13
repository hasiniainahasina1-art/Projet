// goodloka-inspect-join.js – Login + aller sur domino + cliquer sur "Rejoindre" pour voir les conditions
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

async function inspectPage(page, label) {
    console.log(`🔍 Inspection de la page : ${label}`);
    await delay(3000);
    const filename = label.replace(/[^a-zA-Z0-9]/g, '_') + '.png';
    await page.screenshot({ path: path.join(screenshotsDir, filename), fullPage: true });
    console.log(`📸 Capture sauvegardée (${filename})`);

    // Lister tous les textes visibles (pour capturer mise, score, etc.)
    const allTexts = await page.$$eval('*', els =>
        els
            .filter(el => el.offsetParent !== null && el.textContent.trim().length > 0 && el.children.length === 0)
            .map(el => el.textContent.trim().substring(0, 100))
            .slice(0, 30)
    );
    console.log('📝 Textes visibles :');
    allTexts.forEach((t, i) => console.log(`  ${i+1}. "${t}"`));

    // Lister les inputs
    const inputs = await page.$$eval('input', els =>
        els.map(el => ({
            type: el.type || 'text', name: el.name || '', id: el.id || '',
            placeholder: el.placeholder || '', visible: el.offsetParent !== null,
            value: el.value ? el.value.substring(0, 20) : ''
        }))
    );
    console.log('📝 Champs input :');
    inputs.forEach((inp, i) => console.log(`  ${i+1}. type="${inp.type}" name="${inp.name}" id="${inp.id}" placeholder="${inp.placeholder}" visible=${inp.visible}`));

    // Lister les boutons
    const buttons = await page.$$eval('button', els =>
        els.map(el => ({
            text: el.textContent.trim().substring(0, 50), id: el.id || '',
            className: el.className || '', visible: el.offsetParent !== null
        }))
    );
    console.log('🔘 Boutons :');
    buttons.forEach((b, i) => console.log(`  ${i+1}. "${b.text}" id="${b.id}" class="${b.className}" visible=${b.visible}`));

    // Lister les liens
    const links = await page.$$eval('a', els =>
        els.map(el => ({
            text: el.textContent.trim().substring(0, 50), href: el.href || '',
            visible: el.offsetParent !== null
        }))
    );
    console.log('🔗 Liens :');
    links.forEach((l, i) => console.log(`  ${i+1}. "${l.text}" href="${l.href}" visible=${l.visible}`));

    return { inputs, buttons, links, texts: allTexts };
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

(async () => {
    const videoPath = path.join(videosDir, `goodloka_join_inspect_${phone.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
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
        console.log(`📍 URL actuelle : ${page.url()}`);

        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        // 2. Aller sur la liste des jeux et cliquer sur le premier "Jouer"
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        console.log(`🎮 Navigation vers ${gamesListUrl}`);
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
            console.log('⚠️ Clic direct sur le lien échoué, tentative sur le parent...');
            const parentClicked = await page.evaluate(() => {
                const links = [...document.querySelectorAll('a')];
                const jouerLink = links.find(a => a.textContent.trim() === 'Jouer');
                if (jouerLink && jouerLink.parentElement) {
                    jouerLink.parentElement.click();
                    return true;
                }
                return false;
            });
            if (!parentClicked) console.log('⚠️ Aucun clic possible');
        }
        await delay(5000);
        console.log(`📍 URL après clic sur Jouer : ${page.url()}`);

        // 3. Sur la page domino, chercher le bouton "Rejoindre"
        console.log('🔍 Recherche du bouton "Rejoindre"...');
        const joinButtonInfo = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const joinBtn = btns.find(b => b.textContent.trim() === 'Rejoindre');
            if (!joinBtn) return null;
            const rect = joinBtn.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                text: joinBtn.textContent.trim(),
                className: joinBtn.className,
                visible: joinBtn.offsetParent !== null
            };
        });

        if (joinButtonInfo && joinButtonInfo.visible) {
            console.log(`🖱️ Clic sur "Rejoindre" à (${Math.round(joinButtonInfo.x)}, ${Math.round(joinButtonInfo.y)})`);
            await page.mouse.click(joinButtonInfo.x, joinButtonInfo.y);
            await delay(3000);

            // 4. Inspecter la page après le clic (modale ou nouvelle page)
            await inspectPage(page, 'join_conditions');
        } else {
            console.log('⚠️ Bouton "Rejoindre" non trouvé ou invisible. Voici l\'état actuel :');
            await inspectPage(page, 'domino_no_join');
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
