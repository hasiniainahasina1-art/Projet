// goodloka-create-game.js – Créer une partie et inspecter les options (corrigé)
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

async function inspectPage(page, label) {
    console.log(`\n🔍 Inspection : ${label}`);
    await delay(2000);
    const filename = label.replace(/[^a-zA-Z0-9]/g, '_') + '.png';
    await page.screenshot({ path: path.join(screenshotsDir, filename), fullPage: true });
    console.log(`📸 Capture : ${filename}`);

    const texts = await page.$$eval('*', els =>
        els.filter(el => el.offsetParent !== null && el.textContent.trim().length > 0 && el.children.length === 0)
            .map(el => el.textContent.trim().substring(0, 80))
            .slice(0, 30)
    );
    console.log('📝 Textes visibles :');
    texts.forEach((t, i) => console.log(`  ${i+1}. "${t}"`));

    const inputs = await page.$$eval('input', els =>
        els.map(el => ({
            type: el.type || 'text',
            placeholder: el.placeholder || '',
            value: el.value || '',
            visible: el.offsetParent !== null
        }))
    );
    console.log('📝 Champs input :');
    inputs.forEach((inp, i) => console.log(`  ${i+1}. type="${inp.type}" placeholder="${inp.placeholder}" value="${inp.value}" visible=${inp.visible}`));

    const buttons = await page.$$eval('button', els =>
        els.map(el => ({
            text: el.textContent.trim().substring(0, 40),
            className: el.className || '',
            visible: el.offsetParent !== null
        }))
    );
    console.log('🔘 Boutons :');
    buttons.forEach((b, i) => console.log(`  ${i+1}. "${b.text}" class="${b.className}" visible=${b.visible}`));

    const selects = await page.$$eval('select', els =>
        els.map(el => ({
            options: [...el.options].map(o => o.textContent.trim()),
            visible: el.offsetParent !== null
        }))
    );
    console.log('📋 Sélecteurs :');
    selects.forEach((s, i) => console.log(`  ${i+1}. options: [${s.options.join(' | ')}] visible=${s.visible}`));
}

(async () => {
    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: ['--no-sandbox', '--disable-save-password-bubble', '--disable-features=PasswordManager']
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

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
        try { await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 30000 }); } catch (e) {}
        await delay(5000);
        console.log(`📍 URL après connexion : ${page.url()}`);

        // 2. Aller sur la liste des jeux et cliquer sur "Jouer"
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
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
        }
        await delay(5000);
        console.log(`📍 Page domino : ${page.url()}`);

        // 3. Inspecter la page avant création
        await inspectPage(page, 'before_create');

        // 4. Cliquer sur "Créer une partie" (sélection sécurisée)
        console.log('🖱️ Recherche du bouton "Créer une partie"...');
        const allBtns = await page.$$('button');
        let createBtn = null;
        for (const btn of allBtns) {
            const text = await page.evaluate(el => el.textContent.trim(), btn);
            if (text === 'Créer une partie') {
                createBtn = btn;
                break;
            }
        }
        if (createBtn) {
            await createBtn.click();
            console.log('✅ Clic sur "Créer une partie"');
        } else {
            console.log('⚠️ Bouton "Créer une partie" introuvable');
        }
        await delay(3000);

        // 5. Inspecter la modale de création
        await inspectPage(page, 'creation_modal');

        // 6. Garder la page ouverte 1 minute pour observation
        console.log('⏳ Attente 1 minute pour observation...');
        await delay(60000);

        await browser.close();
        console.log('🎉 Inspection terminée.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
