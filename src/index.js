const mqtt  = require('mqtt')
const noble = require('noble')
const log   = require('winston')

const beep_on_itag_connect = process.env.BEEP_ON_ITAG_CONNECT || 'true'

const log_level = process.env.LOG_LEVEL || 'debug'

const mqtt_baseTopic    = process.env.MQTT_BASE_TOPIC || 'itag'
const mqtt_url          = process.env.MQTT_URL ||'mqtt://localhost:1883'
const mqtt_config       = {
                            username: process.env.MQTT_USERNAME || null,
                            password: process.env.MQTT_PASSWORD || null,
                        }

const itag_service_button               = 'ffe0'
const itag_service_immediateAlert       = '1802'
const itag_service_linkLossAlert        = '1803'
const itag_service_battery              = '180f'

const itag_characteristic_click       = 'ffe1'
const itag_characteristic_alertLevel    = '2a06'
const itag_characteristic_batteryLevel  = '2a19'

//https://googlechrome.github.io/samples/web-bluetooth/link-loss.html
const itag_characteristic_alertLevel_value_noAlert      = 0x00 // ITAG no sound
const itag_characteristic_alertLevel_value_mildAlert    = 0x01 // ITAG continous 
const itag_characteristic_alertLevel_value_highAlert    = 0x02 // ITAG beeping

//Sets peripheral variable to be used by RSSI query
var myPeripheral;

//Sets script start time for later counting the up-time seconds of connection.
var start_time = Date.now();

getITAGCharacteristic = (id, serviceId, characteristicID) => {
    peripheral = noble._peripherals[id]
    if (!peripheral) return;
    service = peripheral.services.find((srv)=>srv.uuid===serviceId)
    if (!service) return;
    characteristic = service.characteristics.find((charac)=>charac.uuid===characteristicID)
    return characteristic
}

alertITAGBeep = (id, ms) => {
    log.debug(`ITAG peripheral id: ${id} beep ${ms}`)
    if(ms < 100 || ms > 600000) return;
    immediateAlertLevelCh = getITAGCharacteristic(peripheral.id,itag_service_immediateAlert,itag_characteristic_alertLevel)
    immediateAlertLevelCh.write(new Buffer([itag_characteristic_alertLevel_value_highAlert]), true, ()=>{
        setTimeout(()=>{
            immediateAlertLevelCh.write(new Buffer([itag_characteristic_alertLevel_value_noAlert]), true)
        },ms)
    })
}

alertITAGContinous = (id, ms) => {
    log.debug(`ITAG peripheral id: ${id} continous ${ms}`)
    if(ms < 100 || ms > 600000) return;
    immediateAlertLevelCh = getITAGCharacteristic(peripheral.id,itag_service_immediateAlert,itag_characteristic_alertLevel)
    immediateAlertLevelCh.write(new Buffer([itag_characteristic_alertLevel_value_mildAlert]), true, () => {
        setTimeout(()=>{
            immediateAlertLevelCh.write(new Buffer([itag_characteristic_alertLevel_value_noAlert]), true)
        },ms)
    })
}

onITAGButtonClicked = (peripheral) => {
    mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/button/click`, '1')
    //Sets switch position back to 0, in the future this could be used to set profiles for double or triple click use cases.
    mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/button/click`, '0')
}

onITAGBatteryLevel = (peripheral, data) => {
    mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/battery/level`, data.readUInt8(0).toString())
}

onITAGConnected = (peripheral) => {
    // 300 ms delay due to ITAG disconnects on immediate service discovery
	setTimeout(()=>{
        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics)=>{
            buttonCharacteristics = getITAGCharacteristic(peripheral.id,itag_service_button,itag_characteristic_click)
            buttonCharacteristics.on('data', (data,isNotification) => {
                log.info(`ITAG peripheral id: ${peripheral.id} Button Clicked`) 
                onITAGButtonClicked(peripheral);
            })
            buttonCharacteristics.subscribe((error)=>{ if(error) log.error(error) })

            batteryCharacteristics = getITAGCharacteristic(peripheral.id, itag_service_battery, itag_characteristic_batteryLevel)
            if (typeof batteryCharacteristics !== 'undefined' && batteryCharacteristics !== null) {
                batteryCharacteristics.on('data', (data, isNotification) => {
                    log.info(`ITAG peripheral id: ${peripheral.id} Battery Level = `, data.readUInt8(0) + `%`)
                    onITAGBatteryLevel(peripheral, data);
                })
                batteryCharacteristics.subscribe((error)=>{ if(error) log.error(error) })
                batteryCharacteristics.read()
            }

            linkLossAlertLevelCh = getITAGCharacteristic(peripheral.id,itag_service_linkLossAlert,itag_characteristic_alertLevel)
            if (typeof linkLossAlertLevelCh !== 'undefined' && linkLossAlertLevelCh !== null) {
                linkLossAlertLevelCh.write(new Buffer([itag_characteristic_alertLevel_value_noAlert]), true, (error)=>{
                    if(error) log.error(error)
                    log.debug(`ITAG peripheral id: ${peripheral.id} LinkLoss AlertLevel write success`)
                    if(beep_on_itag_connect==='true') alertITAGContinous(peripheral.id,200)
                });
            }
        })
    },300) 
}

connectITAG = (peripheral) => {
	myPeripheral = peripheral;
  //Calls RSSI funcion evey 6 seconds.
	setInterval(updateRSSI, 6000)
    log.info(`NOBLE peripheral id: ${peripheral.id} connecting`)
    peripheral.connect((error) => {
		
        if(error) { log.error(error); return }
        onITAGConnected(peripheral)
    })
    peripheral.once('connect', ()=>{ 
	    
        log.debug(`NOBLE peripheral id: ${peripheral.id} connected`) 
        mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/presence`, '1')
        mqttClient.subscribe([
            `${mqtt_baseTopic}/${peripheral.id}/alert/continuous`,
            `${mqtt_baseTopic}/${peripheral.id}/alert/beep`,
        ])
        
    })
    peripheral.once('disconnect', ()=>{ 
        log.warn(`NOBLE peripheral id: ${peripheral.id} disconnected`)
        mqttClient.publish(`${mqtt_baseTopic}/${peripheral.id}/presence`, '0')
        mqttClient.unsubscribe([
            `${mqtt_baseTopic}/${peripheral.id}/alert/continuous`,
            `${mqtt_baseTopic}/${peripheral.id}/alert/beep`,
        ])
    })
}

//Sends RSSI over MQTT
function updateRSSI(){
    myPeripheral.updateRssi(function(error, rssi){
    //rssi are always negative values 
    if(rssi < 0) {
		var current_time = Date.now();
		var run_time =((current_time - start_time)/1000)
		log.debug(`iTAG connected id: ${myPeripheral.id} localName: ${myPeripheral.advertisement.localName} state: ${myPeripheral.state} rssi: ${rssi} at ${run_time}`)
		mqttClient.publish(`${mqtt_baseTopic}/${myPeripheral.id}/rssi`, `${rssi}`)
	}
  }); 

}

/*
    noble callbacks 
*/

startScanning = () => { noble.startScanning([], true) } // allow scanning duplicates

onNobleStateChange = (state) => {
    log.info(`NOBLE state: ${state}`)
    if(state === 'poweredOn'){ startScanning() } 
}

onNobleScanStart = () => { log.info('NOBLE scanning started') }

onNobleScanStop  = () => { log.info('NOBLE scanning stopped'); setTimeout(startScanning,3000) } // noble stops scannig when trying to connect to a device 

onNobleDiscover = (peripheral) =>{
    log.debug(`NOBLE discovered id: ${peripheral.id} localName: ${peripheral.advertisement.localName} state: ${peripheral.state}`)
    var name = String(peripheral.advertisement.localName).trim().toUpperCase()
    is_itag             = name == 'ITAG'
    is_not_connected    = peripheral.state == 'disconnected'
	if(is_itag && is_not_connected){ connectITAG(peripheral) }
}

/*
    mqtt callbacks 
*/

onMqttMessage = (topic, message) => {
    log.debug('MQTT topic: '+ topic +' message: ' + message.toString())
    topicElements = topic.split('/')
    if(topicElements.length < 3 || isNaN(message.toString())) return;
    itagId = topicElements[topicElements.length-3]
    alert = topicElements[topicElements.length-2]
    type = topicElements[topicElements.length-1]
    if(alert!==alert) return;
    if(type === 'beep'){
        alertITAGBeep(itagId,parseInt(message.toString()))
        return
    }
    if(type === 'continuous'){
        alertITAGContinous(itagId,parseInt(message.toString()))
        return
    }
}

onMqttConnect = () => { log.info('MQTT connected') }

/*
    #main
*/

log.level = log_level

const mqttClient = mqtt.connect(mqtt_url, mqtt_config)

mqttClient.on('connect', onMqttConnect)
mqttClient.on('message', onMqttMessage)

noble.on('stateChange', onNobleStateChange)
noble.on('scanStart', onNobleScanStart)
noble.on('scanStop', onNobleScanStop)
noble.on('discover', onNobleDiscover)
