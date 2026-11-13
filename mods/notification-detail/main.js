import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";

export default class NotificationDetail extends View {
  render() {
    const p = props() ?? {}, t = theme();
    return v_flex().id("notification-detail").size_full().bg(t.background).text_color(t.foreground).p(16).gap(12)
      .child(h_flex().gap(12).items_center()
        .child(div().flex_1().min_w(0).text_size(16).font_semibold().child(p.title || "Notification"))
        .child(div().id("notification-detail-close").px(9).py(4).rounded(5).cursor_pointer().hover(e => e.bg(t.hover))
          .on_click(() => closeOverlay(p.overlay)).child("Close")))
      .child(div().id("notification-detail-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).rounded(6)
        .bg(t.surface).text_size(13).text_color(t.foreground).whitespace_normal().child(p.body || "No additional details."));
  }
}
