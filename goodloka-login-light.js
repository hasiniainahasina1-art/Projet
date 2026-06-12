// goodloka-login-light.js – Login + inspection dominos (corrigé)
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

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

async function inspectDominoPage(page) {
    console.log('🔍 Inspection de la page de dominos...');
    await delay(5000);
    await page.screenshot({ path: path.join(screenshotsDir, 'domino_page.png'), fullPage: true });
    console.log('📸 Capture sauvegardée (domino_page.png)');

    // Lister les inputs
    const inputs = await page.$$eval('input', els =>
        els.map(el => ({
            type: el.type || 'text',
            name: el.name || '',
            id: el.id || '',
            placeholder: el.placeholder || '',
            className: el.className || '',
            visible: el.offsetParent !== null,
            value: el.value ? el.value.substring(0, 20) : ''
        }))
    );
    console.log('📝 Champs input :');
    inputs.forEach((inp, i) => {
        console.log(`  ${i+1}. type="${inp.type}" name="${inp.name}" id="${inp.id}" placeholder="${inp.placeholder}" visible=${inp.visible}`);
    });

    // Lister les boutons
    const buttons = await page.$$eval('button', els =>
        els.map(el => ({
            text: el.textContent.trim().substring(0, 50),
            id: el.id || '',
            className: el.className || '',
            visible: el.offsetParent !== null
        }))
    );
    console.log('🔘 Boutons :');
    buttons.forEach((b, i) => {
        console.log(`  ${i+1}. "${b.text}" id="${b.id}" class="${b.className}" visible=${b.visible}`);
    });

    // Lister les liens
    const links = await page.$$eval('a', els =>
        els.map(el => ({
            text: el.textContent.trim().substring(0, 50),
            href: el.href || '',
            visible: el.offsetParent !== null
        }))
    );
    console.log('🔗 Liens :');
    links.forEach((l, i) => {
        console.log(`  ${i+1}. "${l.text}" href="${l.href}" visible=${l.visible}`);
    });
}

(async () => {
    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: ['--no-sandbox']
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        // 1. Aller sur la page de login
        const loginUrl = 'https://www.goodloka.com/auth/login';
        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        // 2. Remplir les champs
        await fillFieldHuman(page, 'input[type="text"][placeholder*="Ex"]', phone, 'téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'mot de passe');
        await randomDelay(500, 1500);

        // 3. Appuyer sur Entrée (plus fiable que le clic sur le bouton)
        console.log('⏎ Appui sur Entrée pour valider la connexion...');
        await page.keyboard.press('Enter');

        // 4. Attendre que l'URL ne contienne plus "login"
        console.log('⏳ Attente de la redirection...');
        try {
            await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 30000 });
        } catch (e) {
            console.warn('⚠️ Redirection non détectée, on continue...');
        }
        // Pause supplémentaire pour la stabilisation
        await delay(5000);
        console.log(`📍 URL actuelle : ${page.url()}`);

        // 5. Récupérer les cookies (ils devraient être présents maintenant)
        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        // 6. Aller sur la page de dominos
        const dominoUrl = 'https://domino.goodloka.com/';
        console.log(`🎲 Navigation vers ${dominoUrl}`);
        await page.goto(dominoUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // 7. Inspecter la page de jeu
        await inspectDominoPage(page);

        console.log('🎉 Inspection terminée avec succès.');
        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
