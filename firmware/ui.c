// ui.c — Desk Env home screen (LVGL 8.4, 536x240 landscape)
// Pure LVGL: no Arduino / ESP-IDF calls, so the same file also builds in a PC simulator.
#include "ui.h"
#include "lvgl.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

LV_FONT_DECLARE(jbm_r13);
LV_FONT_DECLARE(jbm_r15);
LV_FONT_DECLARE(jbm_m18);
LV_FONT_DECLARE(jbm_b32);
LV_FONT_DECLARE(jbm_b60);
LV_FONT_DECLARE(jbm_b96);
LV_FONT_DECLARE(jbm_m22);
LV_IMG_DECLARE(img_claude);
LV_IMG_DECLARE(img_copilot);

// ---- palette ---------------------------------------------------------------
#define C_BG      lv_color_hex(0x000000)
#define C_INK     lv_color_hex(0xF2F2F2)
#define C_DIM     lv_color_hex(0x8A8A8A)
#define C_FAINT   lv_color_hex(0x3A3A3A)
#define C_LINE    lv_color_hex(0x262626)
#define C_AMBER   lv_color_hex(0xF5A524)
#define C_CYAN    lv_color_hex(0x4FD1E8)
#define C_GREEN   lv_color_hex(0x3DDC84)
#define C_CLAUDE  lv_color_hex(0xD97757)
#define C_COPILOT lv_color_hex(0x8B7CF6)

// ---- layout (px) -----------------------------------------------------------
#define SCR_W   536
#define SCR_H   240
#define PAD     11
#define BAR_H   26
#define LEFT_W  344
#define TILE_W  167
#define TILE_H  112
#define TILE_Y  119
#define ENV_X   (PAD + LEFT_W + 10)
#define WIFI_W  23
#define WIFI_H  16
#define C_RED   lv_color_hex(0xFF5252)

// ---- widgets we update -----------------------------------------------------
static lv_obj_t *lb_sync_dot, *lb_update;
#define UPDATE_X (PAD + 20) // update notice starts right of the sync dot
static lv_obj_t *scr_home, *scr_setup, *lb_setup_msg, *lb_setup_mac;
static lv_obj_t *wifi_icon, *wifi_part[4]; // [0] = dot, [1..3] = arcs, inner to outer
static lv_obj_t *lb_rssi;
static lv_timer_t *wifi_anim;
static ui_wifi_t wifi_st = UI_WIFI_OFF;
static int wifi_lvl = -1, wifi_anim_step;
static lv_obj_t *lb_sd, *lb_sd_icon;
static lv_obj_t *batt_fill, *batt_box, *batt_nub, *lb_batt, *lb_usb_icon;
static ui_power_t pwr = UI_PWR_UNKNOWN;
static bool clock_big = false;

// pages
static lv_obj_t *scr_page[UI_PAGE_COUNT];
static lv_obj_t *c_code, *c_sub;
static lv_obj_t *m_title, *m_range, *m_count, *m_hint;
#if LV_USE_QRCODE
static lv_obj_t *c_qr;
#define CODE_X -98 // code and hint centered in the space left of the QR
#else
#define CODE_X 0
#endif
static lv_obj_t *ota_box, *ota_spin, *ota_lb, *ota_bar, *ota_sub;
static lv_obj_t *lb_hm, *lb_sec, *lb_wday, *lb_date;
static lv_obj_t *lb_temp, *lb_hum, *lb_iaq, *iaq_box, *lb_temp_u, *lb_hum_u;
static lv_obj_t *lb_lux, *lb_lux_u, *env_line, *k_temp, *k_hum, *k_lux, *k_air;

typedef struct {
    lv_obj_t *tile, *line, *icon, *pct, *desc_l, *desc_r, *mini, *mini_fill;
    lv_point_t pts[48];
    lv_color_t color;
    bool visible;
    bool stale;   // values not fresh: drawn grey
    int progress; // last pct, redrawn when the tile is shown again
} tile_t;
static tile_t t_claude, t_copilot;

// ---- helpers ---------------------------------------------------------------
static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, lv_color_t color, const char *txt)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    lv_label_set_text(l, txt);
    return l;
}

static lv_obj_t *box(lv_obj_t *parent, int x, int y, int w, int h, lv_color_t bg, int radius)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_bg_color(o, bg, 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    return o;
}

// Build the polyline that runs clockwise around a rounded rect, starting at the
// top-left end of the top edge, and stop after `pct` percent of its length.
// Returns the number of points written.
static int border_path(lv_point_t *out, int max_pts, int w, int h, int r, int inset, int pct)
{
    const int SEG = 6; // segments per corner
    lv_point_t full[4 * (SEG + 1) + 1];
    int n = 0;
    float x0 = inset, y0 = inset, x1 = w - 1 - inset, y1 = h - 1 - inset;
    float rr = r - inset;
    // corner centres in clockwise order: top-right, bottom-right, bottom-left, top-left
    float cx[4] = {x1 - rr, x1 - rr, x0 + rr, x0 + rr};
    float cy[4] = {y0 + rr, y1 - rr, y1 - rr, y0 + rr};
    float a0[4] = {-90, 0, 90, 180};
    full[n].x = (lv_coord_t)(x0 + rr); full[n].y = (lv_coord_t)y0; n++;
    for (int c = 0; c < 4; c++) {
        for (int s = 0; s <= SEG; s++) {
            float a = (a0[c] + 90.0f * s / SEG) * 3.14159265f / 180.0f;
            full[n].x = (lv_coord_t)lroundf(cx[c] + rr * cosf(a));
            full[n].y = (lv_coord_t)lroundf(cy[c] + rr * sinf(a));
            n++;
        }
    }
    // total length
    float total = 0;
    for (int i = 1; i < n; i++) total += hypotf(full[i].x - full[i - 1].x, full[i].y - full[i - 1].y);
    float want = total * (pct < 0 ? 0 : pct > 100 ? 100 : pct) / 100.0f;
    if (want <= 0.5f) return 0;

    int m = 0;
    out[m++] = full[0];
    float acc = 0;
    for (int i = 1; i < n && m < max_pts; i++) {
        float seg = hypotf(full[i].x - full[i - 1].x, full[i].y - full[i - 1].y);
        if (acc + seg >= want) {
            float t = seg > 0 ? (want - acc) / seg : 0;
            out[m].x = (lv_coord_t)lroundf(full[i - 1].x + t * (full[i].x - full[i - 1].x));
            out[m].y = (lv_coord_t)lroundf(full[i - 1].y + t * (full[i].y - full[i - 1].y));
            m++;
            return m;
        }
        acc += seg;
        out[m++] = full[i];
    }
    return m;
}

static void tile_set_progress(tile_t *t, int pct)
{
    t->progress = pct;
    int n = border_path(t->pts, 48, TILE_W, TILE_H, 10, 1, pct);
    if (n < 2 || !t->visible) {
        lv_obj_add_flag(t->line, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_line_set_points(t->line, t->pts, n);
        lv_obj_clear_flag(t->line, LV_OBJ_FLAG_HIDDEN);
    }
}

static void tile_create(tile_t *t, lv_obj_t *parent, int x, const lv_img_dsc_t *icon, lv_color_t color,
                        const char *desc_l, bool with_mini)
{
    t->color = color;
    t->visible = true;
    t->tile = lv_obj_create(parent);
    lv_obj_remove_style_all(t->tile);
    lv_obj_set_pos(t->tile, x, TILE_Y);
    lv_obj_set_size(t->tile, TILE_W, TILE_H);
    lv_obj_set_style_radius(t->tile, 10, 0);
    lv_obj_set_style_border_width(t->tile, 2, 0);
    lv_obj_set_style_border_color(t->tile, C_FAINT, 0);
    lv_obj_set_style_border_opa(t->tile, LV_OPA_COVER, 0);
    lv_obj_clear_flag(t->tile, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);

    // coloured part of the border = progress. Child of the screen (not the tile) so its
    // coordinates are not shifted by the tile's border width.
    t->line = lv_line_create(parent);
    lv_obj_set_pos(t->line, x, TILE_Y);
    lv_obj_set_style_line_width(t->line, 3, 0);
    lv_obj_set_style_line_color(t->line, color, 0);
    lv_obj_set_style_line_rounded(t->line, true, 0);

    t->icon = lv_img_create(t->tile);
    lv_img_set_src(t->icon, icon);
    lv_obj_set_style_img_recolor(t->icon, color, 0);
    lv_obj_set_style_img_recolor_opa(t->icon, LV_OPA_COVER, 0);
    lv_obj_set_pos(t->icon, 12, 16);

    t->pct = label(t->tile, &jbm_b32, color, "--");
    lv_obj_align(t->pct, LV_ALIGN_TOP_RIGHT, -12, 20);

    t->desc_l = label(t->tile, &jbm_r13, C_DIM, desc_l);
    lv_obj_set_pos(t->desc_l, 12, 70);
    t->desc_r = label(t->tile, &jbm_r13, C_DIM, with_mini ? "--" : "");
    lv_obj_align(t->desc_r, LV_ALIGN_TOP_RIGHT, -12, 70);

    t->mini = NULL;
    if (with_mini) {
        t->mini = box(t->tile, 12, 92, TILE_W - 24, 3, C_FAINT, 2);
        t->mini_fill = box(t->mini, 0, 0, 0, 3, color, 2);
        lv_obj_set_style_bg_opa(t->mini_fill, LV_OPA_80, 0);
    }
    tile_set_progress(t, -1);
}

static void set_pct_text(lv_obj_t *l, int pct)
{
    if (pct < 0) lv_label_set_text(l, "--");
    else lv_label_set_text_fmt(l, "%d%%", pct);
}

// ---- home layout: tiles shown / hidden, normal or big clock -------------------
static void tile_move(tile_t *t, int x, bool visible)
{
    t->visible = visible;
    lv_obj_set_x(t->tile, x);
    lv_obj_set_x(t->line, x);
    if (visible) lv_obj_clear_flag(t->tile, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(t->tile, LV_OBJ_FLAG_HIDDEN);
    tile_set_progress(t, t->progress); // shows / hides the border line too
}

static void clock_layout(void)
{
    if (clock_big) { // no tiles: clock + date fill the left column
        lv_obj_set_style_text_font(lb_hm, &jbm_b96, 0);
        lv_obj_set_style_text_letter_space(lb_hm, -4, 0);
        lv_obj_align(lb_hm, LV_ALIGN_TOP_LEFT, PAD - 2, 68);
        lv_obj_update_layout(lb_hm);
        lv_obj_align_to(lb_sec, lb_hm, LV_ALIGN_OUT_RIGHT_BOTTOM, 8, -8);
        lv_obj_set_style_text_align(lb_wday, LV_TEXT_ALIGN_LEFT, 0);
        lv_obj_align(lb_wday, LV_ALIGN_TOP_LEFT, PAD + 2, 176);
        lv_obj_update_layout(lb_wday);
        lv_obj_align_to(lb_date, lb_wday, LV_ALIGN_OUT_RIGHT_MID, 10, 0);
    } else {
        lv_obj_set_style_text_font(lb_hm, &jbm_b60, 0);
        lv_obj_set_style_text_letter_space(lb_hm, -2, 0);
        lv_obj_align(lb_hm, LV_ALIGN_TOP_LEFT, PAD, 50);
        lv_obj_update_layout(lb_hm);
        lv_obj_align_to(lb_sec, lb_hm, LV_ALIGN_OUT_RIGHT_BOTTOM, 6, -6);
        lv_obj_set_style_text_align(lb_wday, LV_TEXT_ALIGN_RIGHT, 0);
        lv_obj_align(lb_wday, LV_ALIGN_TOP_RIGHT, -(SCR_W - PAD - LEFT_W), 62);
        lv_obj_set_style_text_align(lb_date, LV_TEXT_ALIGN_RIGHT, 0);
        lv_obj_align(lb_date, LV_ALIGN_TOP_RIGHT, -(SCR_W - PAD - LEFT_W), 82);
    }
}

void ui_set_tiles(bool claude, bool copilot)
{
    static int last = -1;
    int key = claude | copilot << 1;
    if (key == last) return;
    last = key;
    tile_move(&t_claude, PAD, claude);
    tile_move(&t_copilot, PAD + (claude ? TILE_W + 10 : 0), copilot);
    clock_big = !claude && !copilot;
    clock_layout();
}

// ---- pages ---------------------------------------------------------------------
static void page_create(ui_page_t idx, const char *title)
{
    lv_obj_t *s = lv_obj_create(NULL);
    lv_obj_remove_style_all(s);
    lv_obj_set_style_bg_color(s, C_BG, 0);
    lv_obj_set_style_bg_opa(s, LV_OPA_COVER, 0);
    lv_obj_clear_flag(s, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t *h = label(s, &jbm_r13, C_DIM, title);
    lv_obj_set_pos(h, PAD + 4, 10);
    box(s, 0, BAR_H, SCR_W, 1, C_LINE, 0);
    scr_page[idx] = s;
}

static void pages_create(void)
{
    // web login code
    page_create(UI_PAGE_CODE, "WEB LOGIN");
    lv_obj_t *s = scr_page[UI_PAGE_CODE];
    c_code = label(s, &jbm_b60, C_AMBER, "");
    lv_obj_set_style_text_letter_space(c_code, 8, 0);
    lv_obj_align(c_code, LV_ALIGN_CENTER, CODE_X, -6);
    c_sub = label(s, &jbm_r15, C_DIM, "");
    lv_obj_align(c_sub, LV_ALIGN_BOTTOM_MID, CODE_X, -20);
#if LV_USE_QRCODE
    const int qs = 180; // white quiet zone
    lv_obj_t *qbg = box(s, SCR_W - 16 - qs, BAR_H + 16, qs, qs, lv_color_white(), 8);
    c_qr = lv_qrcode_create(qbg, qs - 24, lv_color_black(), lv_color_white());
    lv_obj_center(c_qr);
#endif

    // meeting reminder
    page_create(UI_PAGE_MEETING, "MEETING");
    s = scr_page[UI_PAGE_MEETING];
    m_title = label(s, &jbm_m22, C_INK, "");
    lv_label_set_long_mode(m_title, LV_LABEL_LONG_DOT);
    lv_obj_set_width(m_title, SCR_W - 2 * PAD - 8);
    lv_obj_set_style_text_align(m_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(m_title, LV_ALIGN_TOP_MID, 0, BAR_H + 12);
    m_range = label(s, &jbm_r15, C_DIM, "");
    lv_obj_align(m_range, LV_ALIGN_TOP_MID, 0, BAR_H + 42);
    m_count = label(s, &jbm_b96, C_AMBER, "--:--");
    lv_obj_align(m_count, LV_ALIGN_TOP_MID, 0, BAR_H + 80);
    m_hint = label(s, &jbm_r13, C_DIM, "BOOT = dismiss");
    lv_obj_align(m_hint, LV_ALIGN_BOTTOM_MID, 0, -8);

    // OTA overlay (top layer, above every screen)
    // spinner = still alive (progress can stall on weak Wi-Fi), bar = progress / reboot countdown
    ota_box = box(lv_layer_top(), 0, 0, SCR_W, SCR_H, C_BG, 0);
    ota_spin = lv_spinner_create(ota_box, 1000, 60);
    lv_obj_set_size(ota_spin, 40, 40);
    lv_obj_align(ota_spin, LV_ALIGN_CENTER, 0, -64);
    lv_obj_set_style_arc_width(ota_spin, 3, LV_PART_MAIN);
    lv_obj_set_style_arc_color(ota_spin, C_LINE, LV_PART_MAIN);
    lv_obj_set_style_arc_width(ota_spin, 3, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(ota_spin, C_AMBER, LV_PART_INDICATOR);
    lv_obj_set_style_arc_rounded(ota_spin, true, LV_PART_INDICATOR);
    ota_lb = label(ota_box, &jbm_m22, C_AMBER, "");
    lv_obj_set_style_text_letter_space(ota_lb, 1, 0);
    lv_obj_t *track = box(ota_box, (SCR_W - 300) / 2, SCR_H / 2 + 20, 300, 4, C_FAINT, 2);
    ota_bar = box(track, 0, 0, 0, 4, C_AMBER, 2);
    ota_sub = label(ota_box, &jbm_r15, C_DIM, "");
    lv_obj_add_flag(ota_box, LV_OBJ_FLAG_HIDDEN);
}

void ui_set_update(const char *version)
{
    char text[40] = "";
    if (version[0]) snprintf(text, sizeof text, "UPDATE %s \xC2\xB7 PRESS BOOT", version);
    if (strcmp(lv_label_get_text(lb_update), text)) lv_label_set_text(lb_update, text);
}

void ui_set_code(const char *code, int secs_left)
{
    if (strcmp(lv_label_get_text(c_code), code)) {
        lv_label_set_text(c_code, code);
        lv_obj_align(c_code, LV_ALIGN_CENTER, CODE_X, -6);
#if LV_USE_QRCODE
        if (code[0]) { // the login page signs in with it, see LOGIN_PAGE in web.cpp
            char url[48];
            int len = snprintf(url, sizeof url, "http://workdesk.local/?code=%s", code);
            lv_qrcode_update(c_qr, url, len);
        }
#endif
    }
    lv_label_set_text_fmt(c_sub, "workdesk.local  \xC2\xB7  expires in %d s", secs_left);
    lv_obj_align(c_sub, LV_ALIGN_BOTTOM_MID, CODE_X, -20);
}

void ui_set_meeting(const char *title, const char *range, int secs)
{
    if (strcmp(lv_label_get_text(m_title), title)) lv_label_set_text(m_title, title);
    bool up = secs <= 0;
    char t[64];
    if (up) snprintf(t, sizeof t, "TIME'S UP  \xC2\xB7  %s", range);
    else snprintf(t, sizeof t, "%s", range);
    if (strcmp(lv_label_get_text(m_range), t)) {
        lv_label_set_text(m_range, t);
        lv_obj_set_style_text_color(m_range, up ? C_AMBER : C_DIM, 0);
        lv_obj_align(m_range, LV_ALIGN_TOP_MID, 0, BAR_H + 42);
    }
    if (up) secs = 0;
    if (secs > 99 * 60 + 59) secs = 99 * 60 + 59;
    snprintf(t, sizeof t, "%02d:%02d", secs / 60, secs % 60);
    if (strcmp(lv_label_get_text(m_count), t)) {
        lv_label_set_text(m_count, t);
        lv_obj_set_style_text_color(m_count, up ? C_RED : C_AMBER, 0);
        lv_obj_align(m_count, LV_ALIGN_TOP_MID, 0, BAR_H + 80);
    }
}

static void ota_show(bool spin, lv_color_t color, const char *title, const char *sub, int bar_pct)
{
    lv_obj_clear_flag(ota_box, LV_OBJ_FLAG_HIDDEN);
    if (spin) lv_obj_clear_flag(ota_spin, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(ota_spin, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_text_color(ota_lb, color, 0);
    if (strcmp(lv_label_get_text(ota_lb), title)) lv_label_set_text(ota_lb, title);
    lv_obj_align(ota_lb, LV_ALIGN_CENTER, 0, -14);
    if (strcmp(lv_label_get_text(ota_sub), sub)) lv_label_set_text(ota_sub, sub);
    lv_obj_align(ota_sub, LV_ALIGN_CENTER, 0, 56);
    lv_obj_set_style_bg_color(ota_bar, color, 0);
    lv_obj_set_width(ota_bar, 300 * (bar_pct < 0 ? 0 : bar_pct > 100 ? 100 : bar_pct) / 100);
}

void ui_ota(int pct)
{
    char t[24];
    if (pct < 0) {
        lv_obj_add_flag(ota_box, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    if (pct >= 100) {
        ota_show(false, C_GREEN, "UPDATE OK", "verifying image", 100);
        return;
    }
    snprintf(t, sizeof t, "UPDATING %d%%", pct);
    ota_show(true, C_AMBER, t, "do not unplug", pct);
}

void ui_ota_error(void)
{
    ota_show(false, C_RED, "UPDATE FAILED", "old firmware still running", 0);
}

void ui_reboot(const char *why, int secs, int total)
{
    char t[24];
    if (secs < 0) {
        lv_obj_add_flag(ota_box, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    snprintf(t, sizeof t, "REBOOTING IN %d", secs);
    ota_show(false, C_AMBER, t, why, total > 0 ? secs * 100 / total : 0);
}

// ---- boot splash ----------------------------------------------------------------
#define SPLASH_IN_MS   600
#define SPLASH_HOLD_MS 900
#define SPLASH_OUT_MS  500
static lv_obj_t *scr_splash;
static bool splash_running;

static lv_obj_t *outline(lv_obj_t *parent, int x, int y, int w, int h, lv_color_t c, int bw, int r)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_border_width(o, bw, 0);
    lv_obj_set_style_border_color(o, c, 0);
    lv_obj_set_style_border_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, r, 0);
    lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    return o;
}

// Logo: monitor on a desk, 72 x 54
static void logo_create(lv_obj_t *parent)
{
    outline(parent, 14, 0, 44, 28, C_AMBER, 3, 5);          // monitor
    box(parent, 46, 7, 5, 5, C_CYAN, LV_RADIUS_CIRCLE);      // power dot
    box(parent, 33, 28, 6, 7, C_AMBER, 0);                   // stand
    box(parent, 0, 35, 72, 5, C_INK, 2);                     // desk top
    box(parent, 6, 40, 4, 14, C_INK, 1);                     // legs
    box(parent, 62, 40, 4, 14, C_INK, 1);
}

static void splash_opa(void *o, int32_t v) { lv_obj_set_style_opa((lv_obj_t *)o, (lv_opa_t)v, 0); }
static void splash_y(void *o, int32_t v) { lv_obj_set_style_translate_y((lv_obj_t *)o, v, 0); }

// The splash ends on a black screen; the caller then loads the first real screen
// (connecting / setup / home), so nothing flashes in between.
static void splash_done(lv_anim_t *a)
{
    (void)a;
    splash_running = false;
}

static void splash_drop(void)
{
    if (!scr_splash || splash_running) return;
    lv_obj_del(scr_splash);
    scr_splash = NULL;
}

void ui_splash(void)
{
    scr_splash = lv_obj_create(NULL);
    lv_obj_remove_style_all(scr_splash);
    lv_obj_set_style_bg_color(scr_splash, C_BG, 0);
    lv_obj_set_style_bg_opa(scr_splash, LV_OPA_COVER, 0);
    lv_obj_clear_flag(scr_splash, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *g = lv_obj_create(scr_splash); // logo + name, faded as one
    lv_obj_remove_style_all(g);
    lv_obj_set_size(g, 200, 100);
    lv_obj_center(g);
    lv_obj_clear_flag(g, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_opa(g, LV_OPA_TRANSP, 0);

    lv_obj_t *logo = lv_obj_create(g);
    lv_obj_remove_style_all(logo);
    lv_obj_set_size(logo, 72, 54);
    lv_obj_align(logo, LV_ALIGN_TOP_MID, 0, 0);
    logo_create(logo);

    lv_obj_t *name = label(g, &jbm_m22, C_INK, "workdesk");
    lv_obj_set_style_text_letter_space(name, 2, 0);
    lv_obj_align(name, LV_ALIGN_BOTTOM_MID, 0, 0);

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, g);
    lv_anim_set_exec_cb(&a, splash_opa);
    lv_anim_set_values(&a, LV_OPA_TRANSP, LV_OPA_COVER);
    lv_anim_set_time(&a, SPLASH_IN_MS);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_start(&a);

    lv_anim_set_exec_cb(&a, splash_y); // small rise while fading in
    lv_anim_set_values(&a, 10, 0);
    lv_anim_start(&a);

    lv_anim_set_exec_cb(&a, splash_opa);
    lv_anim_set_values(&a, LV_OPA_COVER, LV_OPA_TRANSP);
    lv_anim_set_time(&a, SPLASH_OUT_MS);
    lv_anim_set_delay(&a, SPLASH_IN_MS + SPLASH_HOLD_MS);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in);
    lv_anim_set_ready_cb(&a, splash_done);
    lv_anim_start(&a);

    splash_running = true;
    lv_scr_load(scr_splash);
}

bool ui_splash_active(void) { return splash_running; }

// ---- connecting screen ------------------------------------------------------------
static lv_obj_t *scr_conn, *conn_status;

static void conn_drop(void)
{
    if (!scr_conn) return;
    lv_obj_del(scr_conn);
    scr_conn = NULL;
    conn_status = NULL;
}

void ui_connecting(const char *status)
{
    if (!scr_conn) {
        scr_conn = lv_obj_create(NULL);
        lv_obj_remove_style_all(scr_conn);
        lv_obj_set_style_bg_color(scr_conn, C_BG, 0);
        lv_obj_set_style_bg_opa(scr_conn, LV_OPA_COVER, 0);
        lv_obj_clear_flag(scr_conn, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t *sp = lv_spinner_create(scr_conn, 1000, 60);
        lv_obj_set_size(sp, 44, 44);
        lv_obj_align(sp, LV_ALIGN_TOP_MID, 0, 40);
        lv_obj_set_style_arc_width(sp, 3, LV_PART_MAIN);
        lv_obj_set_style_arc_color(sp, C_LINE, LV_PART_MAIN);
        lv_obj_set_style_arc_width(sp, 3, LV_PART_INDICATOR);
        lv_obj_set_style_arc_color(sp, C_AMBER, LV_PART_INDICATOR);
        lv_obj_set_style_arc_rounded(sp, true, LV_PART_INDICATOR);

        lv_obj_t *t = label(scr_conn, &jbm_r15, C_INK, "CONNECTING TO WI-FI");
        lv_obj_set_style_text_letter_space(t, 1, 0);
        lv_obj_align(t, LV_ALIGN_TOP_MID, 0, 106);

        conn_status = label(scr_conn, &jbm_r13, C_DIM, "");
        lv_label_set_long_mode(conn_status, LV_LABEL_LONG_DOT);
        lv_obj_set_width(conn_status, SCR_W - 2 * PAD);
        lv_obj_set_style_text_align(conn_status, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_align(conn_status, LV_ALIGN_TOP_MID, 0, 134);

        lv_obj_t *h = label(scr_conn, &jbm_r13, C_FAINT, "BOOT  skip    hold 5 s  setup");
        lv_obj_align(h, LV_ALIGN_BOTTOM_MID, 0, -14);
        lv_scr_load(scr_conn);
        splash_drop();
    }
    if (strcmp(lv_label_get_text(conn_status), status)) lv_label_set_text(conn_status, status);
}

// ---- build -----------------------------------------------------------------
void ui_init(void)
{
    lv_obj_t *scr = scr_home = scr_page[UI_PAGE_HOME] = lv_scr_act();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, C_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    // ---- status bar ----
    lb_sync_dot = box(scr, PAD + 1, 8, 10, 10, C_DIM, LV_RADIUS_CIRCLE);
    box(scr, 0, BAR_H, SCR_W, 1, C_LINE, 0);
    // left of the Wi-Fi icon, after the sync dot; width set by status_reflow(), cut with "..." if short
    lb_update = label(scr, &jbm_r13, C_AMBER, "");
    lv_label_set_long_mode(lb_update, LV_LABEL_LONG_DOT);
    lv_obj_set_pos(lb_update, UPDATE_X, 6);

    // right side, laid out right-to-left
    lb_batt = label(scr, &jbm_r13, C_GREEN, "--%");
    lv_obj_align(lb_batt, LV_ALIGN_TOP_RIGHT, -PAD - 1, 6);
    batt_nub = box(scr, 0, 0, 2, 4, C_GREEN, 1);
    batt_box = lv_obj_create(scr);
    lv_obj_remove_style_all(batt_box);
    lv_obj_set_size(batt_box, 17, 11);
    lv_obj_set_style_border_width(batt_box, 1, 0);
    lv_obj_set_style_border_color(batt_box, C_GREEN, 0);
    lv_obj_set_style_border_opa(batt_box, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(batt_box, 2, 0);
    batt_fill = box(batt_box, 2, 2, 0, 7, C_GREEN, 1);
    lv_obj_align_to(batt_nub, lb_batt, LV_ALIGN_OUT_LEFT_MID, -5, 0);
    lv_obj_align_to(batt_box, batt_nub, LV_ALIGN_OUT_LEFT_MID, 0, 0);
    lb_usb_icon = label(scr, &lv_font_montserrat_14, C_GREEN, LV_SYMBOL_USB);
    lv_obj_add_flag(lb_usb_icon, LV_OBJ_FLAG_HIDDEN);

    lb_sd = label(scr, &jbm_r13, C_DIM, "--");
    lv_obj_align_to(lb_sd, batt_box, LV_ALIGN_OUT_LEFT_MID, -14, 0);
    lb_sd_icon = label(scr, &lv_font_montserrat_14, C_DIM, LV_SYMBOL_SD_CARD);
    lv_obj_align_to(lb_sd_icon, lb_sd, LV_ALIGN_OUT_LEFT_MID, -5, 0);

    // wifi: dot + 3 arcs (classic fan). Each part lights up with one signal level.
    {
        const int cx = WIFI_W / 2, cy = WIFI_H - 2;
        wifi_icon = lv_obj_create(scr);
        lv_obj_remove_style_all(wifi_icon);
        lv_obj_set_size(wifi_icon, WIFI_W, WIFI_H);
        lv_obj_clear_flag(wifi_icon, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
        wifi_part[0] = box(wifi_icon, cx - 2, cy - 2, 4, 4, C_FAINT, LV_RADIUS_CIRCLE);
        for (int i = 1; i <= 3; i++) {
            int r = 2 + 4 * i; // 6, 10, 14
            lv_obj_t *a = lv_arc_create(wifi_icon);
            lv_obj_remove_style_all(a); // no knob, no indicator
            lv_obj_set_pos(a, cx - r, cy - r);
            lv_obj_set_size(a, 2 * r, 2 * r);
            lv_arc_set_bg_angles(a, 225, 315); // 270 = straight up
            lv_obj_set_style_arc_width(a, 2, 0);
            lv_obj_set_style_arc_rounded(a, true, 0);
            lv_obj_set_style_arc_color(a, C_FAINT, 0);
            lv_obj_clear_flag(a, LV_OBJ_FLAG_CLICKABLE);
            wifi_part[i] = a;
        }
        lv_obj_set_y(wifi_icon, 5); // x is set by status_reflow()
        lb_rssi = label(scr, &jbm_r13, C_DIM, "");
    }

    // ---- clock ----
    lb_hm = label(scr, &jbm_b60, C_INK, "--:--");
    lv_obj_set_style_text_letter_space(lb_hm, -2, 0);
    lv_obj_set_pos(lb_hm, PAD, 50);
    lb_sec = label(scr, &jbm_m18, C_DIM, ":--");
    lv_obj_align_to(lb_sec, lb_hm, LV_ALIGN_OUT_RIGHT_BOTTOM, 6, -6);

    lb_wday = label(scr, &jbm_r15, C_DIM, "---");
    lv_obj_set_style_text_align(lb_wday, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_align(lb_wday, LV_ALIGN_TOP_RIGHT, -(SCR_W - PAD - LEFT_W), 62);
    lb_date = label(scr, &jbm_r15, C_DIM, "-- ---");
    lv_obj_set_style_text_align(lb_date, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_align(lb_date, LV_ALIGN_TOP_RIGHT, -(SCR_W - PAD - LEFT_W), 82);

    // ---- AI tiles ----
    tile_create(&t_claude, scr, PAD, &img_claude, C_CLAUDE, "WK", true);
    tile_create(&t_copilot, scr, PAD + TILE_W + 10, &img_copilot, C_COPILOT, "MONTH", false); // one limit only

    // ---- env column ----
    env_line = box(scr, ENV_X, 35, 1, 196, C_LINE, 0);
    k_temp = label(scr, &jbm_r13, C_DIM, "TEMP");
    lb_temp = label(scr, &jbm_b32, C_INK, "--");
    lb_temp_u = label(scr, &jbm_r15, C_DIM, "\xC2\xB0" "C");
    k_hum = label(scr, &jbm_r13, C_DIM, "HUMIDITY");
    lb_hum = label(scr, &jbm_b32, C_CYAN, "--");
    lb_hum_u = label(scr, &jbm_r15, C_DIM, "%");
    k_lux = label(scr, &jbm_r13, C_DIM, "LIGHT");
    lb_lux = label(scr, &jbm_b32, C_AMBER, "--");
    lb_lux_u = label(scr, &jbm_r15, C_DIM, "lx");
    k_air = label(scr, &jbm_r13, C_DIM, "AIR");

    iaq_box = lv_obj_create(scr);
    lv_obj_remove_style_all(iaq_box);
    lv_obj_set_size(iaq_box, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_border_width(iaq_box, 1, 0);
    lv_obj_set_style_border_color(iaq_box, C_FAINT, 0);
    lv_obj_set_style_border_opa(iaq_box, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(iaq_box, 4, 0);
    lv_obj_set_style_pad_hor(iaq_box, 6, 0);
    lv_obj_set_style_pad_ver(iaq_box, 2, 0);
    lv_obj_clear_flag(iaq_box, LV_OBJ_FLAG_SCROLLABLE);
    lb_iaq = label(iaq_box, &jbm_r13, C_DIM, "IAQ --");

    ui_set_env(NAN, NAN, -1, 0, NAN);
    ui_set_claude(-1, -1, false);
    ui_set_copilot(-1, false);
    ui_set_status(-1, -1, UI_PWR_UNKNOWN);
    ui_set_wifi(UI_WIFI_OFF, 0);
    pages_create();
}

// ---- setters ---------------------------------------------------------------
void ui_set_time(int hour, int min, int sec, int wday, int mday, int mon)
{
    static const char *WD[] = {"SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"};
    static const char *MO[] = {"JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"};
    if (hour < 0) { // no time yet (before NTP)
        if (strcmp(lv_label_get_text(lb_hm), "--:--")) {
            lv_label_set_text(lb_hm, "--:--");
            lv_label_set_text(lb_sec, ":--");
            lv_label_set_text(lb_wday, "--");
            lv_label_set_text(lb_date, "--");
        }
        return;
    }
    lv_label_set_text_fmt(lb_hm, "%02d:%02d", hour, min);
    lv_label_set_text_fmt(lb_sec, ":%02d", sec);
    if (wday >= 0 && wday < 7) lv_label_set_text(lb_wday, WD[wday]);
    if (mon >= 1 && mon <= 12) lv_label_set_text_fmt(lb_date, "%d %s", mday, MO[mon - 1]);
}

static void show(lv_obj_t *o, bool visible)
{
    if (visible) lv_obj_clear_flag(o, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN);
}

// One key + value row of the env column at y (value 22 below, or 14 when four rows share it).
static void env_row(lv_obj_t *key, lv_obj_t *value, int y, int gap)
{
    lv_obj_set_pos(key, ENV_X + 14, y);
    lv_obj_set_pos(value, ENV_X + 14, y + gap);
}

// The column follows the sensors that are plugged in, and stays empty with none.
static void env_layout(bool bme, bool bh)
{
    static int shown = -1;
    int key = bme | bh << 1;
    if (key == shown) return;
    shown = key;
    show(env_line, bme || bh);
    show(k_temp, bme); show(lb_temp, bme); show(lb_temp_u, bme);
    show(k_hum, bme);  show(lb_hum, bme);  show(lb_hum_u, bme);
    show(k_air, bme);  show(iaq_box, bme);
    show(k_lux, bh);   show(lb_lux, bh);   show(lb_lux_u, bh);
    if (bme && bh) {
        env_row(k_temp, lb_temp, 31, 14);
        env_row(k_hum, lb_hum, 79, 14);
        env_row(k_lux, lb_lux, 127, 14);
        env_row(k_air, iaq_box, 176, 18);
    } else if (bme) {
        env_row(k_temp, lb_temp, 38, 22);
        env_row(k_hum, lb_hum, 112, 22);
        env_row(k_air, iaq_box, 186, 20);
    } else {
        env_row(k_lux, lb_lux, 38, 22);
    }
}

void ui_set_env(float temp_c, float hum_pct, int iaq, int iaq_acc, float lux)
{
    char buf[16];
    env_layout(!isnan(temp_c), !isnan(lux));
    if (!isnan(lux)) {
        snprintf(buf, sizeof buf, "%.0f", lux);
        lv_label_set_text(lb_lux, buf);
        lv_obj_update_layout(lb_lux);
        lv_obj_align_to(lb_lux_u, lb_lux, LV_ALIGN_OUT_RIGHT_BOTTOM, 3, 0);
    }
    if (isnan(temp_c)) lv_label_set_text(lb_temp, "--");
    else { snprintf(buf, sizeof buf, "%.1f", temp_c); lv_label_set_text(lb_temp, buf); }
    if (isnan(hum_pct)) lv_label_set_text(lb_hum, "--");
    else { snprintf(buf, sizeof buf, "%.0f", hum_pct); lv_label_set_text(lb_hum, buf); }

    lv_obj_update_layout(lb_temp);
    lv_obj_align_to(lb_temp_u, lb_temp, LV_ALIGN_OUT_RIGHT_BOTTOM, 3, 0);
    lv_obj_update_layout(lb_hum);
    lv_obj_align_to(lb_hum_u, lb_hum, LV_ALIGN_OUT_RIGHT_BOTTOM, 3, 0);

    lv_color_t c = C_DIM, border = C_FAINT;
    // accuracy 0 = BSEC warm-up (value meaningless); 1-2 = still calibrating: colour the text but
    // keep the border faint; 3 = calibrated: coloured border too
    bool warm = iaq >= 0 && iaq_acc == 0;
    if (iaq < 0) {
        lv_label_set_text(lb_iaq, "IAQ --");
    } else if (warm) {
        lv_label_set_text(lb_iaq, "IAQ WARM-UP");
    } else {
        const char *word = iaq <= 50 ? "GOOD" : iaq <= 100 ? "OK" : iaq <= 150 ? "FAIR" : iaq <= 200 ? "POOR" : "BAD";
        c = iaq <= 100 ? C_GREEN : iaq <= 200 ? C_AMBER : C_RED;
        if (iaq_acc >= 3) border = c;
        lv_label_set_text_fmt(lb_iaq, "IAQ %d \xC2\xB7 %s", iaq, word);
    }
    lv_obj_set_style_text_color(lb_iaq, c, 0);
    lv_obj_set_style_border_color(iaq_box, border, 0);
    lv_obj_set_style_border_opa(iaq_box, border.full == C_FAINT.full ? LV_OPA_COVER : LV_OPA_50, 0);
}

// Both tiles: big % + border = session, "WK" % + mini bar = week. Stale -> everything grey
// (last values kept, so a dropped feed doesn't make the tile vanish).
static void tile_set_usage(tile_t *t, int session_pct, int week_pct, bool stale)
{
    lv_color_t c = stale ? C_DIM : t->color;
    if (stale != t->stale) {
        t->stale = stale;
        lv_obj_set_style_img_recolor(t->icon, c, 0);
        lv_obj_set_style_line_color(t->line, c, 0);
        if (t->mini) lv_obj_set_style_bg_color(t->mini_fill, c, 0);
    }
    lv_obj_set_style_text_color(t->pct, session_pct < 0 ? C_DIM : c, 0); // "--" (e.g. no session) always grey
    set_pct_text(t->pct, session_pct);
    tile_set_progress(t, session_pct);
    if (!t->mini) return;
    if (week_pct < 0) {
        lv_label_set_text(t->desc_r, "--");
        lv_obj_set_width(t->mini_fill, 0);
    } else {
        lv_label_set_text_fmt(t->desc_r, "%d%%", week_pct);
        lv_obj_set_width(t->mini_fill, (TILE_W - 24) * (week_pct > 100 ? 100 : week_pct) / 100);
    }
    lv_obj_align(t->desc_r, LV_ALIGN_TOP_RIGHT, -12, 70);
}

void ui_set_claude(int session_pct, int week_pct, bool stale) { tile_set_usage(&t_claude, session_pct, week_pct, stale); }
void ui_set_copilot(int month_pct, bool stale) { tile_set_usage(&t_copilot, month_pct, -1, stale); }

// Lay out the right side of the status bar, right to left (label widths change).
static void status_reflow(void)
{
    lv_obj_align(lb_batt, LV_ALIGN_TOP_RIGHT, -PAD - 1, 6);
    lv_obj_update_layout(lb_batt);
    lv_obj_t *left; // left-most part of the power indicator
    if (pwr == UI_PWR_USB) {
        lv_obj_align_to(lb_usb_icon, lb_batt, LV_ALIGN_OUT_LEFT_MID, -5, 0);
        left = lb_usb_icon;
    } else {
        lv_obj_align_to(batt_nub, lb_batt, LV_ALIGN_OUT_LEFT_MID, -5, 0);
        lv_obj_align_to(batt_box, batt_nub, LV_ALIGN_OUT_LEFT_MID, 0, 0);
        left = batt_box;
    }
    lv_obj_align_to(lb_sd, left, LV_ALIGN_OUT_LEFT_MID, -14, 0);
    lv_obj_update_layout(lb_sd);
    lv_obj_align_to(lb_sd_icon, lb_sd, LV_ALIGN_OUT_LEFT_MID, -5, 0);
    lv_obj_update_layout(lb_sd_icon);
    int x = lv_obj_get_x(lb_sd_icon) - 14;
    if (lv_label_get_text(lb_rssi)[0]) {
        lv_obj_update_layout(lb_rssi);
        x -= lv_obj_get_width(lb_rssi);
        lv_obj_set_pos(lb_rssi, x, 6);
        x -= 5;
    }
    lv_obj_set_x(wifi_icon, x - WIFI_W);
    int room = x - WIFI_W - 12 - UPDATE_X; // never runs into the Wi-Fi icon
    lv_obj_set_width(lb_update, room > 0 ? room : 0);
}

void ui_set_sync(ui_sync_t s)
{
    lv_color_t c = s == UI_SYNC_BUSY ? C_AMBER : s == UI_SYNC_OK ? C_GREEN : s == UI_SYNC_ERROR ? C_RED : C_DIM;
    lv_obj_set_style_bg_color(lb_sync_dot, c, 0);
}

void ui_set_status(int sd_gb, int batt_pct, ui_power_t power)
{
    pwr = power;

    if (sd_gb < 0) lv_label_set_text(lb_sd, "--");
    else lv_label_set_text_fmt(lb_sd, "%dG", sd_gb);

    bool usb = power == UI_PWR_USB;
    lv_color_t bc = (!usb && batt_pct >= 0 && batt_pct < 20) ? C_RED : C_GREEN;
    if (usb) lv_label_set_text(lb_batt, "USB");
    else if (batt_pct < 0) lv_label_set_text(lb_batt, "--%");
    else lv_label_set_text_fmt(lb_batt, "%d%%", batt_pct);
    if (usb) {
        lv_obj_add_flag(batt_box, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(batt_nub, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(lb_usb_icon, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_clear_flag(batt_box, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(batt_nub, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(lb_usb_icon, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_set_style_text_color(lb_batt, bc, 0);
    lv_obj_set_style_border_color(batt_box, bc, 0);
    lv_obj_set_style_bg_color(batt_nub, bc, 0);
    lv_obj_set_style_bg_color(batt_fill, bc, 0);
    lv_obj_set_width(batt_fill, batt_pct < 0 ? 0 : 11 * (batt_pct > 100 ? 100 : batt_pct) / 100);

    status_reflow();
}

// ---- wifi ------------------------------------------------------------------
// level 0..4: dot = 1, arcs = 2..4
static void wifi_light(int level)
{
    if (level == wifi_lvl) return;
    wifi_lvl = level;
    lv_obj_set_style_bg_color(wifi_part[0], level > 0 ? C_CYAN : C_FAINT, 0);
    for (int i = 1; i < 4; i++)
        lv_obj_set_style_arc_color(wifi_part[i], level > i ? C_CYAN : C_FAINT, 0);
}

static void wifi_anim_cb(lv_timer_t *t)
{
    (void)t;
    wifi_anim_step = (wifi_anim_step + 1) % 5;
    wifi_light(wifi_anim_step);
}

static int rssi_level(int dbm)
{
    return dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
}

void ui_set_wifi(ui_wifi_t st, int rssi_dbm)
{
    if (st != wifi_st) {
        wifi_st = st;
        if (wifi_anim) { lv_timer_del(wifi_anim); wifi_anim = NULL; }
        if (st == UI_WIFI_CONNECTING) {
            wifi_anim_step = 0;
            wifi_light(0);
            wifi_anim = lv_timer_create(wifi_anim_cb, 300, NULL);
        }
    }
    if (st != UI_WIFI_CONNECTING) wifi_light(st == UI_WIFI_ON ? rssi_level(rssi_dbm) : 0);

    char txt[12] = "";
    if (st == UI_WIFI_ON) snprintf(txt, sizeof txt, "%ddBm", rssi_dbm);
    else if (st == UI_WIFI_AP) snprintf(txt, sizeof txt, "AP");
    if (strcmp(txt, lv_label_get_text(lb_rssi)) != 0) {
        lv_label_set_text(lb_rssi, txt);
        status_reflow();
    }
}

// ---- setup screen ------------------------------------------------------------
static void setup_kv(lv_obj_t *parent, int x, int y, const char *key, const char *val)
{
    lv_obj_t *k = label(parent, &jbm_r13, C_DIM, key);
    lv_obj_set_pos(k, x, y + 2);
    lv_obj_t *v = label(parent, &jbm_r15, C_INK, val);
    lv_obj_set_pos(v, x + 48, y);
}

void ui_show_setup(const char *ap_ssid, const char *ap_pass, const char *url, const char *mac, bool can_cancel)
{
    if (!scr_setup) {
        scr_setup = lv_obj_create(NULL);
        lv_obj_remove_style_all(scr_setup);
        lv_obj_set_style_bg_color(scr_setup, C_BG, 0);
        lv_obj_set_style_bg_opa(scr_setup, LV_OPA_COVER, 0);
        lv_obj_clear_flag(scr_setup, LV_OBJ_FLAG_SCROLLABLE);
    }
    lv_obj_clean(scr_setup);
    lv_obj_t *s = scr_setup;

#if LV_USE_QRCODE
    // Standard Wi-Fi QR: phone camera offers to join the AP directly.
    char uri[96];
    snprintf(uri, sizeof uri, "WIFI:T:WPA;S:%s;P:%s;;", ap_ssid, ap_pass);
    const int qs = SCR_H - 2 * 20; // white quiet zone, 200 px
    lv_obj_t *qbg = box(s, 20, 20, qs, qs, lv_color_white(), 8);
    lv_obj_t *qr = lv_qrcode_create(qbg, qs - 24, lv_color_black(), lv_color_white());
    lv_qrcode_update(qr, uri, strlen(uri));
    lv_obj_center(qr);
    const int x = 20 + qs + 20;
#else
    const int x = PAD + 10;
#endif
    const int in = 27; // indent under "1  "

    lv_obj_t *l = label(s, &jbm_r15, C_AMBER, "WI-FI SETUP");
    lv_obj_set_style_text_letter_space(l, 1, 0);
    lv_obj_set_pos(l, x, 16);
    if (can_cancel) {
        l = label(s, &jbm_r13, C_DIM, "BOOT = cancel");
        lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -PAD, 18);
    }

    l = label(s, &jbm_r13, C_DIM, LV_USE_QRCODE ? "1  Scan the code, or join" : "1  On your phone, join");
    lv_obj_set_pos(l, x, 44);
    setup_kv(s, x + in, 64, "SSID", ap_ssid);
    setup_kv(s, x + in, 84, "PASS", ap_pass);

    l = label(s, &jbm_r13, C_DIM, "2  If no page opens, go to");
    lv_obj_set_pos(l, x, 112);
    l = label(s, &jbm_r15, C_INK, url);
    lv_obj_set_pos(l, x + in, 130);

    // device MAC (some networks only admit registered MACs); changes live from the web page
    l = label(s, &jbm_r13, C_DIM, "MAC");
    lv_obj_set_pos(l, x, 160);
    lb_setup_mac = label(s, &jbm_r15, C_INK, mac);
    lv_obj_set_pos(lb_setup_mac, x + in + 48, 158);

    lb_setup_msg = label(s, &jbm_r13, C_CYAN, "");
    lv_label_set_long_mode(lb_setup_msg, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(lb_setup_msg, SCR_W - x - PAD);
    lv_obj_set_pos(lb_setup_msg, x, 188);
    lv_scr_load(scr_setup);
    conn_drop();
    splash_drop();
}

void ui_setup_mac(const char *mac)
{
    if (lb_setup_mac && strcmp(lv_label_get_text(lb_setup_mac), mac)) lv_label_set_text(lb_setup_mac, mac);
}

void ui_setup_msg(const char *msg, bool error)
{
    if (!lb_setup_msg) return;
    lv_label_set_text(lb_setup_msg, msg);
    lv_obj_set_style_text_color(lb_setup_msg, error ? C_RED : C_CYAN, 0);
}

void ui_show_page(ui_page_t page)
{
    if (page < 0 || page >= UI_PAGE_COUNT) page = UI_PAGE_HOME;
    if (lv_scr_act() != scr_page[page]) lv_scr_load(scr_page[page]);
    conn_drop();
    splash_drop();
    if (scr_setup) {
        lv_obj_del(scr_setup); // frees the QR canvas
        scr_setup = NULL;
        lb_setup_msg = NULL;
        lb_setup_mac = NULL;
    }
}
