// fwupdate.h — downloads new firmware from GitHub in the background; BOOT installs it.
#pragma once
#include <Arduino.h>

void fwupdate_begin(const char *fw_version);
void fwupdate_offer(const char *version); // version Workdesk reported; called from the API task
void fwupdate_poll();                     // downloads an offered version; called from the API task
const char *fwupdate_ready();             // version waiting for BOOT, "" = none
bool fwupdate_install();                  // boots it after the usual reboot warning
bool fwupdate_busy();
String fwupdate_msg();                    // last result for the web page, "" = nothing yet
