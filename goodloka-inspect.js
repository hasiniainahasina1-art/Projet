// goodloka-inspect.js – Liste les champs de la page de login GoodLoka
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');

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

        const loginUrl = 'https://www.goodloka.com/auth/login';
        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 5000)); // attendre 5s

        // Capture d'écran
        const screenshotsDir = path.join(__dirname, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotsDir, 'goodloka_login.png'), fullPage: true });
        console.log('📸 Capture sauvegardée (goodloka_login.png)');

        // Lister tous les inputs
        const inputs = await page.$$eval('input', els =>
            els.map(el => ({
                type: el.type || 'text',
                name: el.name || '',
                id: el.id || '',
                placeholder: el.placeholder || '',
                autocomplete: el.autocomplete || '',
                className: el.className || '',
                visible: el.offsetParent !== null,
                value: el.value ? el.value.substring(0, 20) : ''
            }))
        );
        console.log('📝 Champs input trouvés :');
        inputs.forEach((inp, i) => {
            console.log(`  ${i+1}. type="${inp.type}" name="${inp.name}" id="${inp.id}" placeholder="${inp.placeholder}" visible=${inp.visible} value="${inp.value}"`);
        });

        // Lister les boutons
        const buttons = await page.$$eval('button', els =>
            els.map(el => ({
                text: el.textContent.trim().substring(0, 30),
                id: el.id || '',
                className: el.className || '',
                visible: el.offsetParent !== null
            }))
        );
        console.log('🔘 Boutons trouvés :');
        buttons.forEach((b, i) => {
            console.log(`  ${i+1}. "${b.text}" id="${b.id}" class="${b.className}" visible=${b.visible}`);
        });

        console.log('✅ Diagnostic terminé.');
        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
