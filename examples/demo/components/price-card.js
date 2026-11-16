Component({
  properties: {
    price: {
      type: Number,
      value: 0
    },
    editing: {
      type: Boolean,
      value: false
    }
  },

  methods: {
    onTap() {
      this.triggerEvent("edit", { value: this.data.price });
    }
  }
});
