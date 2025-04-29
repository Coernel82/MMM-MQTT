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

  audio: null, // define audio to prelaod the sound
  subscriptions: [], // initialize subscriptions as an empty array

  start: function () {
    Log.info(this.name + " started.");

    // Preload audio if not already loaded
    if (!sub.playAlarm._audio) {
      sub.playAlarm._audio = new Audio('/modules/MMM-MQTT/sounds/alarm.wav'); // TODO: hardcoded for debugging / testing
      sub.playAlarm._audio.load();
    }

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
      sortOrder: sub.sortOrder || 10,
      colors: sub.colors,
      conversions: sub.conversions,
      multiply: sub.multiply,
      divide: sub.divide,
      broadcast: sub.broadcast,
      hidden: sub.hidden,
      playAlarm: sub.playAlarm || { enabled: false },
      flashValue: sub.flashValue || { enabled: false },
      alarmTriggered: false
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

        if (sub.jsonpointer) {
          value = get(JSON.parse(value), sub.jsonpointer);
        }

        if (sub.decimalSignInMessage) {
          value = value.replace(sub.decimalSignInMessage, ".");
        }

        value = this.multiply(sub, value);

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
          if (sub.playAlarm.enabled) {
            const conditionMet = this.checkCondition(
              sub.value,
              sub.playAlarm.operator,
              sub.playAlarm.value
            );
            if (conditionMet && !sub.alarmTriggered) {
              const audio = sub.playAlarm._audio;
              audio.play().catch((error) => {
                Log.error("Failed to play alarm audio:", error);
              });
              sub.alarmTriggered = true;
            } else if (!conditionMet) {
              sub.alarmTriggered = false;
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

        // Flash condition
        if (sub.flashValue.enabled) {
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

        // Flash condition
        if (sub.flashValue.enabled) {
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
  }
});