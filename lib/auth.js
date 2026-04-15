export async function isLoggedIn(page) {
    const url = page.url();

    // si on est encore sur login → pas connecté
    if (url.includes('login.php')) return false;

    // vérifier un élément présent après login
    const logoutBtn = await page.$('a[href*="logout"], .logout');

    if (logoutBtn) return true;

    return false;
}
