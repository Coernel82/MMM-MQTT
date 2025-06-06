Module.register("MMM-MQTT", {
  log: function (...args) {
    if (this.config.logging) {
      args.forEach((arg) => Log.info(arg));
    }
  },

  getScripts: function () {
    return [
      this.file("./jsonpointer.js"),
      this.file("./topics_match.js"),
      this.file("./utils.js")
    ];
  },

  // Default module config
  defaults: {
    mqttServers: [],
    logging: false,
    useWildcards: false,
    bigMode: false
  },

/*   audio: null, // define audio to prelaod the sound
  subscriptions: [], // initialize subscriptions as an empty array
 */
  start: function () {
    Log.info(this.name + " started.");

    this.subscriptions = this.makeSubscriptions(this.config.mqttServers);
    this.openMqttConnection();
    setInterval(() => {
      this.updateDom(100);
    }, 5000);
  },

  makeSubscriptions: function (mqttServers) {
    this.log(
      `${this.name}: Setting up connection to ${mqttServers.length} servers`
    );
    return mqttServers.flatMap((server) => {
      this.log(
        `${this.name}: Adding config for ${server.address} port ${server.port} user ${server.user}`
      );
      return server.subscriptions.map((subscr) => {
        return this.makeSubscription(makeServerKey(server), subscr);
      });
    });
  },

  makeSubscription: function (key, sub) {

    let playAlarmConfig = { enabled: false };
    if (sub.playAlarm) {
      playAlarmConfig = {
        enabled: sub.playAlarm.enabled,
        operator: sub.playAlarm.operator,
        value: sub.playAlarm.value,
        audioPath: sub.playAlarm.audio,
        _audio: sub.playAlarm.audio ? new Audio(sub.playAlarm.audio) : null,
        repeat: sub.playAlarm.repeat || false
      };
      if (playAlarmConfig._audio) {
        playAlarmConfig._audio.loop = playAlarmConfig.repeat;
      }
    }

    return {
      serverKey: key,
      label: sub.label,
      topic: sub.topic,
      decimals: sub.decimals,
      decimalSignInMessage: sub.decimalSignInMessage,
      jsonpointer: sub.jsonpointer,
      suffix: typeof sub.suffix == "undefined" ? "" : sub.suffix,
      value: "",
      time: Date.now(),
      maxAgeSeconds: sub.maxAgeSeconds,
      sortOrder: sub.sortOrder || 10, // TODO: Fix sort order i * 100 + j
      colors: sub.colors,
      conversions: sub.conversions,
      multiply: sub.multiply,
      divide: sub.divide,
      broadcast: sub.broadcast,
      hidden: sub.hidden,
      flashValue: sub.flashValue || { enabled: false },
      playAlarm: playAlarmConfig,
      alarmTriggered: false,
      flashDismissed: false,
      soundDismissed: false
    };
  },

  checkCondition: function (value, operator, threshold) {
    const numValue = Number(value);
    const numThreshold = Number(threshold);
    if (isNaN(numValue) || isNaN(numThreshold)) return false;
    switch (operator) {
      case '<': return numValue < numThreshold;
      case '>': return numValue > numThreshold;
      case '<=': return numValue <= numThreshold;
      case '>=': return numValue >= numThreshold;
      case '==': return numValue === numThreshold;
      default: return false;
    }
  },

  openMqttConnection: function () {
    this.sendSocketNotification("MQTT_CONFIG", this.config);
  },

  setSubscriptionValue: function (subscriptions, payload, useWildcards) {
    const savedValues = new Map(Object.entries(JSON.parse(payload)));
    for (let i = 0; i < subscriptions.length; i++) {
      let sub = subscriptions[i];
      const savedValue = savedValues.get(sub.serverKey + "-" + sub.topic);
      if (savedValue &&
        (sub.serverKey === savedValue.serverKey && useWildcards
          ? topicsMatch(sub.topic, savedValue.topic)
          : sub.topic === savedValue.topic)
      ) {
        let value = savedValue.value;

        if (sub.broadcast) {
          this.sendNotification("MQTT_MESSAGE_RECEIVED", savedValue);
        }

        // Extract value from JSON pointer if configured
        if (sub.jsonpointer) {
          value = get(JSON.parse(value), sub.jsonpointer);
        }

        // Convert decimal point
        if (sub.decimalSignInMessage) {
          value = value.replace(sub.decimalSignInMessage, ".");
        }

        // Multiply or divide
        value = this.multiply(sub, value);

        // Round decimals if configured
        if (!isNaN(sub.decimals)) {
          value = isNaN(value) ? value : Number(value).toFixed(sub.decimals);
        }
        sub.value = value;
        sub.time = savedValue.time;
      }
    }
    return subscriptions;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "MQTT_PAYLOAD") {
      if (payload != null) {
        this.log("Received message: ", payload);
        this.setSubscriptionValue(
          this.subscriptions,
          payload,
          this.config.useWildcards
        );

        // Check playAlarm conditions
        this.subscriptions.forEach((sub) => {
          if (sub.playAlarm.enabled && sub.playAlarm._audio) {
            const conditionMet = this.checkCondition(
              sub.value,
              sub.playAlarm.operator,
              sub.playAlarm.value
            );
            const audio = sub.playAlarm._audio;
    
            if (conditionMet) {
              if (!sub.alarmTriggered) {
                sub.flashDismissed = false;
                sub.soundDismissed = false;
                audio.play().catch((error) => {
                  Log.error("Failed to play alarm audio:", error);
                });
                sub.alarmTriggered = true;
              }
            } else {
              if (sub.alarmTriggered) {
                audio.pause();
                audio.currentTime = 0;
                sub.alarmTriggered = false;
              }
            }
          }
        });

        this.updateDom();
      } else {
        Log.info(this.name + ": MQTT_PAYLOAD - No payload");
      }
    }
  },

  getStyles: function () {
    return ["MQTT.css"];
  },

  isValueTooOld: function (maxAgeSeconds, updatedTime) {
    return maxAgeSeconds
      ? updatedTime + maxAgeSeconds * 1000 < Date.now()
      : false;
  },

  getColors: function (sub) {
    if (!sub.colors || sub.colors.length === 0) return {};
    let colors;
    if (!Array.isArray(sub.colors)) {
      colors = sub.colors;
    } else {
      for (let i = 0; i < sub.colors.length; i++) {
        colors = sub.colors[i];
        if (sub.value < sub.colors[i].upTo) break;
      }
    }
    return colors;
  },

  multiply: function (sub, value) {
    if (!sub.multiply && !sub.divide) return value;
    if (!value || isNaN(value)) return value;
    let res = (+value * (sub.multiply || 1)) / (sub.divide || 1);
    return isNaN(res) ? value : res.toString();
  },

  convertValue: function (sub) {
    if (!sub.conversions || sub.conversions.length === 0) return sub.value;
    for (let i = 0; i < sub.conversions.length; i++) {
      if (sub.value.toString().trim() === sub.conversions[i].from.toString().trim()) {
        return sub.conversions[i].to;
      }
    }
    return sub.value;
  },

  getDom: function () {
    return this.config.bigMode
      ? this.getWrapperBigMode()
      : this.getWrapperListMode();
  },

  getWrapperListMode: function () {
    const wrapper = document.createElement("table");
    wrapper.className = "small";


    if (this.subscriptions.length === 0) {
      wrapper.innerHTML = this.loaded ? this.translate("EMPTY") : this.translate("LOADING");
      wrapper.className = "small dimmed";
      return wrapper;
    }

    this.subscriptions
      .filter((s) => !s.hidden)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach((sub) => {
        const subWrapper = document.createElement("tr");
        const colors = this.getColors(sub);
        const tooOld = this.isValueTooOld(sub.maxAgeSeconds, sub.time);

        // Label
        const labelWrapper = document.createElement("td");
        labelWrapper.innerHTML = sub.label;
        labelWrapper.className = "align-left mqtt-label";
        labelWrapper.style.color = colors.label;
        subWrapper.appendChild(labelWrapper);

        // Value
        const valueWrapper = document.createElement("td");
        const value = this.convertValue(sub);
        valueWrapper.innerHTML = value;
        valueWrapper.className = `align-right medium mqtt-value ${tooOld ? "dimmed" : "bright"}`;
        valueWrapper.style.color = tooOld ? valueWrapper.style.color : colors.value;
        valueWrapper.addEventListener("click", () => this.handleAlarmDismiss(sub));

        // Flash condition
        if (sub.flashValue.enabled && !sub.flashDismissed) {
          const conditionMet = this.checkCondition(
            sub.value,
            sub.flashValue.operator,
            sub.flashValue.value
          );
          if (conditionMet) {
            valueWrapper.classList.add("mqtt-flash");
            // Apply custom color if specified
            if (sub.flashValue.flashColor) {
              valueWrapper.style.color = sub.flashValue.flashColor;
              valueWrapper.style.animation = "none"; // Force reflow
              void valueWrapper.offsetWidth; // Trigger reflow
              valueWrapper.style.animation = "";
            }
          } else {
            valueWrapper.classList.remove("mqtt-flash");
            // Reset to original color when not flashing
            valueWrapper.style.color = tooOld ? valueWrapper.style.color : colors.value;
          }
        } else {
          // Remove flashing when dismissed or disabled
          valueWrapper.classList.remove("mqtt-flash");
          valueWrapper.style.color = tooOld ? valueWrapper.style.color : colors.value;
        }
        subWrapper.appendChild(valueWrapper);

        // Suffix
        const suffixWrapper = document.createElement("td");
        suffixWrapper.innerHTML = sub.suffix;
        suffixWrapper.className = "align-left mqtt-suffix";
        suffixWrapper.style.color = colors.suffix;
        subWrapper.appendChild(suffixWrapper);

        if (value !== "#DISABLED#") wrapper.appendChild(subWrapper);
      });

    return wrapper;
  },

  getWrapperBigMode: function () {
    const wrapper = document.createElement("div");
    wrapper.className = "small";

    if (this.subscriptions.length === 0) {
      wrapper.innerHTML = this.loaded ? this.translate("EMPTY") : this.translate("LOADING");
      wrapper.className = "small dimmed";
      return wrapper;
    }

    this.subscriptions
      .filter((s) => !s.hidden)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach((sub) => {
        const subWrapper = document.createElement("div");
        subWrapper.className = "mqtt-big";
        const colors = this.getColors(sub);
        const tooOld = this.isValueTooOld(sub.maxAgeSeconds, sub.time);

        // Label
        const labelWrapper = document.createElement("div");
        labelWrapper.innerHTML = sub.label;
        labelWrapper.className = "align-center mqtt-big-label";
        labelWrapper.style.color = colors.label;
        subWrapper.appendChild(labelWrapper);

        // Value Row
        const valueRowWrapper = document.createElement("div");
        valueRowWrapper.className = "mqtt-big-value-row";

        // Value
        const valueWrapper = document.createElement("span");
        const value = this.convertValue(sub);
        valueWrapper.innerHTML = value;
        valueWrapper.className = `large mqtt-big-value ${tooOld ? "dimmed" : "bright"}`;
        valueWrapper.style.color = tooOld ? valueWrapper.style.color : colors.value;
        valueWrapper.addEventListener("click", () => this.handleAlarmDismiss(sub));
        

        // Flash condition
        if (sub.flashValue.enabled && !sub.flashDismissed) {
          const conditionMet = this.checkCondition(
            sub.value,
            sub.flashValue.operator,
            sub.flashValue.value
          );
          if (conditionMet) valueWrapper.classList.add("flash");
        }

        valueRowWrapper.appendChild(valueWrapper);

        // Suffix
        const suffixWrapper = document.createElement("span");
        suffixWrapper.innerHTML = sub.suffix;
        suffixWrapper.className = "medium mqtt-big-suffix";
        suffixWrapper.style.color = colors.suffix;
        valueRowWrapper.appendChild(suffixWrapper);

        subWrapper.appendChild(valueRowWrapper);
        if (value !== "#DISABLED#") wrapper.appendChild(subWrapper);
      });

    return wrapper;
  },

  handleAlarmDismiss: function(sub) {
    // Check current dismissal state: first mute sound, then stop flash
    if (sub.flashValue.enabled && sub.playAlarm.enabled) {
      if (!sub.soundDismissed) {
        // First click - dismiss sound
        sub.soundDismissed = true;
        const audio = sub.playAlarm._audio;
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
      } else if (!sub.flashDismissed) {
        // Second click - dismiss flash
        sub.flashDismissed = true;
      }
    } else if (sub.playAlarm.enabled) {
      // Single click - dismiss sound
      sub.soundDismissed = true;
      const audio = sub.playAlarm._audio;
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    } else if (sub.flashValue.enabled) {
      // Single click - dismiss flash
      sub.flashDismissed = true;
    }
    
    this.updateDom();
  },


});