let nextId = 0;

export function initToastStore(Alpine) {
    Alpine.store("toast", {
        items: [],

        show(message, type = "info", ms = 4000) {
            const id = ++nextId;
            this.items = [...this.items, { id, message, type, visible: false }];
            requestAnimationFrame(() => {
                this.items = this.items.map(t => t.id === id ? { ...t, visible: true } : t);
            });
            setTimeout(() => {
                this.items = this.items.map(t => t.id === id ? { ...t, visible: false } : t);
                setTimeout(() => {
                    this.items = this.items.filter(t => t.id !== id);
                }, 300);
            }, ms);
        },
    });
}
