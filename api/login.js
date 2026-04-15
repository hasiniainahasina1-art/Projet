
import puppeteer from 'puppeteer-core';
import { saveCookies, loadCookies } from '../lib/cookies';
import { isLoggedIn } from '../lib/auth';

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// URLs plateformes
const siteUrls = {
    tronpick: 'https://tronpick.io/login.php',
    litepick: 'https://litepick.io/login.php',
    dogepick: 'https://dogepick.io/login.php',
    solpick: 'https://solpick.io/login.php',
    binpick: 'https://binpick.io/login.php'
};

export default async function handler(req, res) {

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non autorisée' });
    }

    if (!BROWSERLESS_TOKEN) {
        return res.status(500).json({ error: 'Token manquant' });
    }

    const { email, password, platform } = req.body;

    if (!email || !password || !platform) {
        return res.status(400).json({ error: 'Champs manquants' });
    }

    const loginUrl = siteUrls[platform];

    if (!loginUrl) {
        return res.status(400).json({ error: 'Plateforme inconnue' });
    }

    let browser;

    try {

        // 🔌 Connexion Browserless
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });

        const page = await browser.newPage();

        // viewport réaliste
        await page.setViewport({
            width: 1280 + Math.floor(Math.random() * 100),
            height: 720 + Math.floor(Math.random() * 100)
        });

        console.log(`🌐 Navigation vers ${loginUrl}`);

        // 🍪 1. Charger cookies
        const hasCookies = await loadCookies(page, email);

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

        // 🔁 2. Tester cookies
        if (hasCookies) {
            console.log('♻️ Test session avec cookies...');
            await page.reload();

            await delay(3000 + Math.random() * 3000);

            const logged = await isLoggedIn(page);

            if (logged) {
                console.log('✅ Session valide avec cookies');

                const cookies = await page.cookies();
                await browser.close();

                return res.status(200).json({
                    success: true,
                    cookies,
                    reused: true
                });
            } else {
                console.log('❌ Cookies expirés → login requis');
            }
        }

        // ✍️ 3. LOGIN NORMAL

        console.log('⌨️ Remplissage formulaire');

        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 5000 });

        await page.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');

        await page.type('input[type="email"], input[name="email"]', email, {
            delay: 50 + Math.random() * 100
        });

        await page.waitForSelector('input[type="password"]', { timeout: 5000 });

        await page.click('input[type="password"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');

        await page.type('input[type="password"]', password, {
            delay: 50 + Math.random() * 100
        });

        // ⏳ pause humaine
        await delay(5000 + Math.random() * 5000);

        // 🔐 cliquer login
        console.log('🔐 Clic sur Login');

        const loginBtn = await page.$('button[type="submit"], button');

        if (!loginBtn) {
            throw new Error('Bouton login introuvable');
        }

        await loginBtn.click();

        await page.waitForNavigation({ timeout: 10000 }).catch(() => {});

        await delay(3000);

        // ✅ Vérification login
        const logged = await isLoggedIn(page);

        if (!logged) {
            throw new Error('Échec de connexion');
        }

        console.log('✅ Login réussi');

        // 🍪 4. Sauvegarder cookies
        await saveCookies(page, email);

        const cookies = await page.cookies();

        await browser.close();

        return res.status(200).json({
            success: true,
            cookies,
            reused: false
        });

    } catch (error) {

        console.error('❌ Erreur:', error.message);

        if (browser) {
            await browser.close();
        }

        return res.status(500).json({
            error: error.message
        });
    }
}
