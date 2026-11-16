Page({
  data: {
    order: {
      no: "",
      total: 0
    },
    hint: "Tap the price to edit it"
  },

  onLoad(query) {
    this.setData({
      order: { no: query.no || "WG-1001", total: 128 }
    });
  },

  onEditPrice(event) {
    this.setData({ "order.total": event.detail.value });
  },

  onHint() {
    this.setData({ hint: "The price updates in place" });
  }
});
