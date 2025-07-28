import {Page} from 'puppeteer';

export interface TrackingData {
    status: string;
    date: string;
}

export interface TrackingRequest {
    resi: string;
    courier: string;
}

export const cekResi = async (payload: TrackingRequest, page: Page): Promise<TrackingData[]> => {
    const {resi, courier} = payload;
    const url = `https://cekresi.com/?v=wi1&noresi=${resi}`;
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });

    await page.waitForSelector('#cekresi', {visible: true});
    await page.click('#cekresi');

    const courierSelector = `a[onclick="setExp('${courier}');doCheckR()"]`;
    await page.waitForSelector(courierSelector, {timeout: 15000});
    await page.click(courierSelector);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForSelector('a.accordion-toggle[href="#collapseTwo"]', {timeout: 15000});
    await page.click('a.accordion-toggle[href="#collapseTwo"]');

    const html = await page.content();
    console.log(html)
    return await page.$$eval('.panel-group .panel:last-of-type tr', trs =>
        trs
            .map(tr => {
                const cells = tr.querySelectorAll('td');
                if (cells.length >= 2) {
                    return {
                        date: cells[0]?.textContent?.trim() ?? '',
                        status: cells[1]?.textContent?.trim() ?? '',
                    };
                }
                return null;
            })
            .filter((item): item is TrackingData => item !== null)
    );
};


export const courierFunctions: Record<string, (payload: TrackingRequest, page: Page) => Promise<TrackingData[]>> = {
    'cekresi': cekResi,
};