package cn.gezhixin.smarthome.tvagent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        AdbSettings.enableAndSchedule(context.createDeviceProtectedStorageContext());
    }
}
