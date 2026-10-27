import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

for (const role of ['student', 'teacher']) {
  test(`${role} login keeps one input boundary and visible keyboard focus`, async ({ page }) => {
    await page.goto(`/${role}/login`);
    const input = page.getByRole('textbox').first();
    const password = page.locator('input[type="password"]');
    const button = page.getByRole('button', { name: role === 'student' ? '显示密码' : '登录', exact: true });
    const radius = await input.evaluate(element => getComputedStyle(element).borderRadius);
    const buttonRadius = await button.evaluate(element => getComputedStyle(element).borderRadius);
    const idleBorder = await input.evaluate(element => getComputedStyle(element).borderColor);

    await input.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveCSS('outline-style', 'none');
    await expect(input).toHaveCSS('border-radius', radius);
    await expect(input).not.toHaveCSS('border-color', idleBorder);
    await input.press('Tab');
    await expect(password).toBeFocused();
    await expect(password).toHaveCSS('outline-style', 'none');
    await password.press('Tab');
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS('outline-style', 'solid');
    await expect(button).toHaveCSS('outline-width', '2px');
    await expect(button).toHaveCSS('border-radius', buttonRadius);

    if (role === 'student') {
      await password.click();
      await button.click();
      const hidePassword = page.getByRole('button', { name: '隐藏密码', exact: true });
      await expect(hidePassword).toBeFocused();
      await expect(hidePassword).toHaveCSS('outline-style', 'none');
    }
  });
}
