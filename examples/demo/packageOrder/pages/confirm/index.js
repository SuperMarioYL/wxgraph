Page({
  data: {
    orderNo: "",
    total: 0
  },

  onLoad(query) {
    this.setData({
      orderNo: query.no || "WG-1001",
      total: Number(query.total) || 0
    });
  },

  onSubmit() {
    wx.navigateBack();
  }
});
