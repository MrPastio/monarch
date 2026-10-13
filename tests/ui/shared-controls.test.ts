// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { enhanceSelect, initSharedSelects } from '../../src/ui/public/modules/ui-select.js';
import { confirmAction, promptValue, promptSecurityPin } from '../../src/ui/public/modules/ui-dialogs.js';
beforeEach(() => {
 HTMLElement.prototype.showPopover = function () {};
 HTMLElement.prototype.hidePopover = function () {};
 HTMLDialogElement.prototype.showModal = function () { this.open = true; };
 HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
 document.body.innerHTML = '<button id="origin">Открыть</button><label for="choice">Выбор</label><select id="choice"><option value="one">Первый</option><option value="two">Второй</option></select>';
});
afterEach(() => document.body.replaceChildren());
it('reflects programmatic selection, visibility and disabled state', async () => {
 const select = document.querySelector('select')!; enhanceSelect(select); select.value = 'two';
 await vi.waitFor(() => expect(document.querySelector('.max-model-trigger')!.textContent).toContain('Второй'));
 select.hidden = true; select.disabled = true;
 await vi.waitFor(() => { const trigger = document.querySelector('.max-model-trigger') as HTMLButtonElement; expect(trigger.hidden).toBe(true); expect(trigger.disabled).toBe(true); });
});
it('enhances new selects without duplicating existing controls', async () => {
 initSharedSelects(); document.body.insertAdjacentHTML('beforeend','<select id="new"><option>A</option></select>');
 await vi.waitFor(() => expect(document.querySelectorAll('.max-model-trigger')).toHaveLength(2));
 enhanceSelect(document.querySelector('select')); expect(document.querySelectorAll('.max-model-trigger')).toHaveLength(2);
});
it('defaults confirmation to cancel and never queues a second action', async () => {
 document.getElementById('origin')!.focus(); const first = confirmAction('Удалить запись?');
 expect(document.activeElement?.textContent).toBe('Отмена'); expect(await confirmAction('Второй запрос')).toBe(false);
 (document.querySelector('.monarch-question-dialog .claude-secondary-btn') as HTMLButtonElement).click();
 expect(await first).toBe(false); expect(document.activeElement?.id).toBe('origin');
});
it('confirms only after explicit submit and uses text-safe messages', async () => {
 const result = confirmAction('<img src=x>'); expect(document.querySelector('.monarch-question-dialog img')).toBeNull();
 document.querySelector('.monarch-question-dialog form')!.dispatchEvent(new Event('submit',{cancelable:true})); expect(await result).toBe(true);
});
it('returns edited text and clears the removed prompt', async () => {
 const result = promptValue('Название','Старое'); const input = document.querySelector('.monarch-question-dialog input') as HTMLInputElement; input.value='Новое';
 document.querySelector('.monarch-question-dialog form')!.dispatchEvent(new Event('submit',{cancelable:true})); expect(await result).toBe('Новое'); expect(input.value).toBe('');
});
it('masks the security PIN and clears it on cancellation without queueing another prompt', async () => {
 const result = promptSecurityPin('Остановить защиту');
 const input = document.querySelector('.monarch-question-dialog input') as HTMLInputElement;
 expect(input.type).toBe('password'); expect(input.maxLength).toBe(6); expect(input.pattern).toBe('[0-9]{6}');
 input.value='123456'; expect(await promptSecurityPin('Повтор')).toBeNull();
 (document.querySelector('.monarch-question-dialog .claude-secondary-btn') as HTMLButtonElement).click();
 expect(await result).toBeNull(); expect(input.value).toBe('');
});
