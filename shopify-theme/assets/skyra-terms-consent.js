if (!customElements.get('skyra-terms-gate')) {
  customElements.define('skyra-terms-gate', class extends HTMLElement {
    connectedCallback() {
      this.controller?.abort();
      this.controller = new AbortController();
      const options = { signal: this.controller.signal };
      const checkbox = this.querySelector('[data-terms-consent]');
      if (!checkbox) return;
      checkbox.checked = false;
      const update = () => {
        this.querySelectorAll('[data-terms-checkout]').forEach(button => {
          button.disabled = !checkbox.checked || button.dataset.cartEmpty === 'true';
        });
        this.querySelectorAll('[data-terms-payment]').forEach(payment => {
          payment.hidden = !checkbox.checked;
          payment.inert = !checkbox.checked;
        });
      };
      checkbox.addEventListener('change', update, options);
      this.addEventListener('click', event => {
        if (!checkbox.checked && event.target.closest('[name="checkout"], [data-terms-payment]')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          checkbox.reportValidity();
        }
      }, { ...options, capture: true });
      update();
    }
    disconnectedCallback() { this.controller?.abort(); }
  });
}
