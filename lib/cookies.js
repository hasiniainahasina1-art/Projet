import fs from 'fs';
import path from 'path';

const cookiesPath = path.join(process.cwd(), 'data', 'cookies');

// créer dossier si n'existe pas
if (!fs.existsSync(cookiesPath)) {
    fs.mkdirSync(cookiesPath, { recursive: true });
}

// sauvegarder cookies
export async function saveCookies(page, name) {
    const cookies = await page.cookies();
    const filePath = path.join(cookiesPath, `${name}.json`);

    fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2));

    console.log(`🍪 Cookies sauvegardés: ${name}`);
}

// charger cookies
export async function loadCookies(page, name) {
    const filePath = path.join(cookiesPath, `${name}.json`);

    if (!fs.existsSync(filePath)) {
        console.log('❌ Aucun cookie trouvé');
        return false;
    }

    const cookies = JSON.parse(fs.readFileSync(filePath));

    await page.setCookie(...cookies);

    console.log(`🍪 Cookies chargés: ${name}`);
    return true;
}
