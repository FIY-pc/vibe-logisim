// Small choice surfaces share geometry and keyboard behavior, not domain state.
export function placeAbove(panel, trigger, width) {
  const anchor = trigger.getBoundingClientRect(), edge = 12, gap = 8;
  const above = anchor.top - edge - gap, below = innerHeight - anchor.bottom - edge - gap;
  const upward = above >= 160 || above >= below;
  const available = Math.max(40, upward ? above : below);
  const actualWidth = Math.min(width, innerWidth - edge * 2);
  panel.style.width = actualWidth + 'px';
  panel.style.maxHeight = available + 'px';
  panel.style.left = Math.max(edge, Math.min(anchor.left, innerWidth - actualWidth - edge)) + 'px';
  panel.style.top = (upward ? Math.max(edge, anchor.top - panel.offsetHeight - gap) : anchor.bottom + gap) + 'px';
  panel.dataset.side = upward ? 'top' : 'bottom';
}

export function choiceMenu({trigger, panel, width, onOpen}) {
  const isOpen = () => panel.matches(':popover-open');
  const options = () => [...panel.querySelectorAll('[role="menuitemradio"]:not(:disabled)')];
  const position = () => { if (isOpen()) placeAbove(panel, trigger, width); };
  function focusChoice() {
    const items = options();
    (items.find(item => item.getAttribute('aria-checked') === 'true') || items[0] || panel).focus();
  }
  function close(restoreFocus = false) {
    if (!isOpen()) return;
    panel.hidePopover();
    if (restoreFocus) trigger.focus();
  }
  async function open() {
    panel.showPopover(); position(); panel.focus();
    await onOpen();
    if (isOpen()) { position(); if (document.activeElement === panel) focusChoice(); }
  }
  panel.tabIndex = -1;
  trigger.addEventListener('click', () => { if (isOpen()) close(true); else void open(); });
  trigger.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); if (!isOpen()) void open(); else focusChoice();
  });
  panel.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(isOpen())));
  panel.addEventListener('keydown', event => {
    const items = options(), index = items.indexOf(document.activeElement);
    if (['ArrowUp','ArrowDown','Home','End'].includes(event.key) && items.length) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 :
        (index + (event.key === 'ArrowDown' ? 1 : items.length-1)) % items.length;
      items[next].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(true);
    } else if (event.key === 'Tab') close();
  });
  window.addEventListener('resize', position);
  return {isOpen, position, close};
}
