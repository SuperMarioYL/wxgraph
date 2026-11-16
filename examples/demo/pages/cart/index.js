Page({
  data: {
    items: [
      { id: "espresso", unitPrice: 68 },
      { id: "filter", unitPrice: 12 }
    ],
    editing: false
  },

  onLoad(query) {
    const patch = Object.assign({}, this.data, query);
    this.setData(patch);
  },

  onEdit(event) {
    const { id, value } = event.detail;
    const items = this.data.items.map((item) =>
      item.id === id ? Object.assign({}, item, { unitPrice: value }) : item
    );
    this.setData({ items, editing: true });
  },

  onCheckout() {
    wx.cloud.callFunction({ name: "checkout" });
  }
});
