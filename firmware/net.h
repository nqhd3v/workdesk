// net.h — Wi-Fi: saved credentials (NVS), setup portal (soft AP + captive page), NTP
#pragma once
#include <Arduino.h>

#define TZ_INFO "ICT-7"  // Asia/Ho_Chi_Minh, UTC+7

enum net_state_t { NET_OFF, NET_CONNECTING, NET_CONNECTED, NET_PORTAL };

void net_begin();          // once in setup(): join the saved network, or open the portal if there is none
void net_loop();           // call often from loop() (DNS + web server + state machine)
void net_start_portal();
void net_stop_portal();    // leave the portal and rejoin the saved network (needs saved credentials)
bool net_has_creds();

net_state_t net_state();
int net_rssi();            // dBm, 0 when not connected
bool net_time_synced();    // true once NTP has set the clock
String net_device_id();    // "workdesk-xxxx" (factory MAC): X-Device-Id for the backend. AP + OTA host = "workdesk"
// Backend (Workdesk): base URL + API key, kept in NVS, set on the setup page or the local web page.
String net_api_token();    // "" = none (secret: never log it, use net_api_key_hint())
String net_api_url();      // "https://host" without a trailing slash, "" = none
String net_api_key_hint(); // "wdk_7mxS..." for display, "" = none
// url nullptr = keep the URL; key "" = keep the key (both nullptr / "" = remove the key).
bool net_set_backend(const char *url, const char *key, String *err);
String net_mac();          // STA MAC in use, "aa:bb:cc:dd:ee:ff"
bool net_mac_custom();     // set on the setup page (applied at boot, before the Wi-Fi driver starts)

// Boot: true until the first connection, while saved networks are being tried.
// If none works the portal opens by itself (also after 3 failed rounds later on).
bool net_booting();
const char *net_status(); // what the connect cycle is doing, for the connecting screen
bool net_portal_busy();   // portal is joining the network from the form (or just joined it)

// OTA (ArduinoOTA, LAN push) runs while connected. Password = the setup AP password.
// The callback gets 0..100 during an update, -1 when it fails (it runs inside net_loop(),
// which blocks while the image streams in). On success the reboot waits REBOOT_WARN_MS.
void net_on_ota(void (*cb)(int pct));
// Progress from any OTA source (ArduinoOTA, HTTP upload): 0..99, 100 = installed (schedules the
// reboot), -1 = failed. Repeats are dropped.
void net_ota_report(int pct);

// Planned reboots (OTA done, MAC change) wait REBOOT_WARN_MS so the screen can warn.
#define REBOOT_WARN_MS 5000
int net_reboot_in();             // whole seconds until the reboot, -1 = none planned
const char *net_reboot_reason(); // short upper-case reason for the warning screen

// Portal info for the setup screen
const char *net_ap_ssid();
const char *net_ap_pass();
const char *net_portal_url();
const char *net_portal_msg();
bool net_portal_msg_error();
uint32_t net_portal_rev(); // changes whenever the message changes
