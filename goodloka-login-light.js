// goodloka-login-light.js – Login + inspection de games/list puis clic vers domino
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

async function inspectPage(page, label) {
    console.log(`🔍 Inspection de la page : ${label}`);
    await delay(3000);
    const filename = label.replace(/[^a-zA-Z0-9]/g, '_') + '.png';
    await page.screenshot({ path: path.join(screenshotsDir, filename), fullPage: true });
    console.log(`📸 Capture sauvegardée (${filename})`);

    // Lister les inputs
    const inputs = await page.$$eval('input', els =>
        els.map(el => ({
            type: el.type || 'text',
            name: el.name || '',
            id: el.id || '',
            placeholder: el.placeholder || '',
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

    return { buttons, links };
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

        // 2. Attendre la redirection (URL ne contenant plus "login")
        console.log('⏳ Attente de la redirection...');
        try {
            await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 30000 });
        } catch (e) {
            console.warn('⚠️ Redirection non détectée, on continue...');
        }
        await delay(5000);
        console.log(`📍 URL actuelle : ${page.url()}`);

        // 3. Récupérer les cookies (s'ils existent)
        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        // 4. Inspecter la page après connexion (normalement games/list)
        await inspectPage(page, 'games_list');

        // 5. Chercher un lien ou bouton qui mène au domino
        console.log('🔍 Recherche d\'un élément pour aller au domino...');
        const dominoElement = await page.evaluate(() => {
            // Chercher d'abord un lien dont le texte contient "domino" ou "Domino"
            const links = [...document.querySelectorAll('a')];
            const dominoLink = links.find(a => /domino/i.test(a.textContent));
            if (dominoLink) return { type: 'link', text: dominoLink.textContent.trim(), href: dominoLink.href };

            // Sinon chercher un bouton
            const buttons = [...document.querySelectorAll('button')];
            const dominoBtn = buttons.find(b => /domino/i.test(b.textContent));
            if (dominoBtn) return { type: 'button', text: dominoBtn.textContent.trim() };

            // Essayer avec "jouer" ou "play"
            const playLink = links.find(a => /jouer|play/i.test(a.textContent));
            if (playLink) return { type: 'link', text: playLink.textContent.trim(), href: playLink.href };

            return null;
        });

        if (dominoElement) {
            console.log(`🎯 Élément trouvé : "${dominoElement.text}" (${dominoElement.type})`);
            if (dominoElement.type === 'link') {
                await page.goto(dominoElement.href, { waitUntil: 'networkidle2', timeout: 60000 });
            } else {
                // Clic sur le bouton (coordonnées)
                const coords = await page.evaluate(() => {
                    const btn = [...document.querySelectorAll('button')].find(b => /domino/i.test(b.textContent));
                    if (!btn) return null;
                    const rect = btn.getBoundingClientRect();
                    return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
                });
                if (coords) {
                    // On utilise une fonction de clic humain simple (déjà définie plus haut) mais ici on va juste cliquer normalement
                    await page.mouse.click(coords.x, coords.y);
                }
            }
            await delay(5000);
            console.log(`📍 URL après clic : ${page.url()}`);

            // 6. Inspecter la page domino
            await inspectPage(page, 'domino');
        } else {
            console.log('⚠️ Aucun élément domino trouvé sur la page games/list. Voici la liste des liens et boutons :');
            // On reliste pour aider
            await inspectPage(page, 'games_list_bis');
        }

        console.log('🎉 Inspection terminée avec succès.');
        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
