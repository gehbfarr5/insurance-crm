package com.kjgx.unsecure;

import android.app.Activity;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * Clears FLAG_SECURE universally inside com.cpic.kjgxplus without requiring a system_server reboot.
 */
public final class UnsecureHook implements IXposedHookLoadPackage {
    private static final String TARGET_PKG = "com.cpic.kjgxplus";
    private static final int FLAG_SECURE = WindowManager.LayoutParams.FLAG_SECURE;

    @Override
    public void handleLoadPackage(final XC_LoadPackage.LoadPackageParam lpparam) {
        if (lpparam == null || !TARGET_PKG.equals(lpparam.packageName)) {
            return;
        }
        if (!TARGET_PKG.equals(lpparam.processName)) {
            return;
        }

        hookWindowFlags();
        hookWindowManagerGlobal();
        hookSurfaceView();
        hookActivityOnResume();
        XposedBridge.log("KJGXUnsecure: hooks installed for " + lpparam.processName);
    }

    private static void hookWindowFlags() {
        try {
            XposedHelpers.findAndHookMethod(
                Window.class,
                "setFlags",
                int.class,
                int.class,
                new XC_MethodHook() {
                    @Override
                    protected void beforeHookedMethod(MethodHookParam param) {
                        int flags = (Integer) param.args[0];
                        int mask = (Integer) param.args[1];
                        if ((flags & FLAG_SECURE) != 0) {
                            param.args[0] = flags & ~FLAG_SECURE;
                        }
                        // Ensure FLAG_SECURE bit in mask clears if caller explicitly sets 0, and never sets 1.
                        if ((mask & FLAG_SECURE) != 0 && (flags & FLAG_SECURE) != 0) {
                            param.args[0] = flags & ~FLAG_SECURE;
                        }
                    }
                }
            );
        } catch (Throwable t) {
            XposedBridge.log("KJGXUnsecure: Window.setFlags hook failed: " + t.getMessage());
        }

        try {
            XposedHelpers.findAndHookMethod(
                Window.class,
                "addFlags",
                int.class,
                new XC_MethodHook() {
                    @Override
                    protected void beforeHookedMethod(MethodHookParam param) {
                        int flags = (Integer) param.args[0];
                        if ((flags & FLAG_SECURE) != 0) {
                            param.args[0] = flags & ~FLAG_SECURE;
                        }
                    }
                }
            );
        } catch (Throwable t) {
            XposedBridge.log("KJGXUnsecure: Window.addFlags hook failed: " + t.getMessage());
        }

        try {
            XposedHelpers.findAndHookMethod(
                Window.class,
                "setAttributes",
                WindowManager.LayoutParams.class,
                new XC_MethodHook() {
                    @Override
                    protected void beforeHookedMethod(MethodHookParam param) {
                        Object arg = param.args[0];
                        if (arg instanceof WindowManager.LayoutParams) {
                            WindowManager.LayoutParams lp = (WindowManager.LayoutParams) arg;
                            lp.flags &= ~FLAG_SECURE;
                        }
                    }
                }
            );
        } catch (Throwable t) {
            XposedBridge.log("KJGXUnsecure: Window.setAttributes hook failed: " + t.getMessage());
        }
    }

    private static void hookWindowManagerGlobal() {
        try {
            Class<?> wmg = Class.forName("android.view.WindowManagerGlobal");
            XposedBridge.hookAllMethods(wmg, "addView", new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    stripParamsSecureFlag(param.args);
                }
            });
            XposedBridge.hookAllMethods(wmg, "updateViewLayout", new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    stripParamsSecureFlag(param.args);
                }
            });
        } catch (Throwable t) {
            XposedBridge.log("KJGXUnsecure: WindowManagerGlobal hook failed: " + t.getMessage());
        }
    }

    private static void stripParamsSecureFlag(Object[] args) {
        if (args == null) return;
        for (Object arg : args) {
            if (arg instanceof WindowManager.LayoutParams) {
                ((WindowManager.LayoutParams) arg).flags &= ~FLAG_SECURE;
            } else if (arg instanceof ViewGroup.LayoutParams && arg instanceof WindowManager.LayoutParams) {
                ((WindowManager.LayoutParams) arg).flags &= ~FLAG_SECURE;
            }
        }
    }

    private static void hookSurfaceView() {
        try {
            XposedHelpers.findAndHookMethod(
                SurfaceView.class,
                "setSecure",
                boolean.class,
                new XC_MethodHook() {
                    @Override
                    protected void beforeHookedMethod(MethodHookParam param) {
                        param.args[0] = Boolean.FALSE;
                    }
                }
            );
        } catch (Throwable t) {
            XposedBridge.log("KJGXUnsecure: SurfaceView.setSecure hook failed: " + t.getMessage());
        }
    }

    private static void hookActivityOnResume() {
        try {
            XposedHelpers.findAndHookMethod(
                Activity.class,
                "onResume",
                new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        Object self = param.thisObject;
                        if (!(self instanceof Activity)) return;
                        Window w = ((Activity) self).getWindow();
                        if (w != null) {
                            w.clearFlags(FLAG_SECURE);
                        }
                    }
                }
            );
        } catch (Throwable t) {
            XposedBridge.log("KJGXUnsecure: Activity.onResume hook failed: " + t.getMessage());
        }
    }
}
