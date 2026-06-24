import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import HomeScreen from './src/screens/HomeScreen';
import WriteOffScreen from './src/screens/WriteOffScreen';

const Tab = createBottomTabNavigator();

const C = { bg: '#111827', border: '#1f2937', blue: '#3b82f6', inactive: '#6b7280' };

export default function App() {
  return (
    <NavigationContainer theme={{ dark: true, colors: { background: '#030712', card: C.bg, text: '#f9fafb', border: C.border, notification: C.blue, primary: C.blue } }}>
      <StatusBar style="light" />
      <Tab.Navigator screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: { backgroundColor: C.bg, borderTopColor: C.border, height: 80, paddingBottom: 20 },
        tabBarActiveTintColor: C.blue,
        tabBarInactiveTintColor: C.inactive,
        tabBarIcon: ({ focused, color, size }) => {
          const icons: Record<string, { focused: keyof typeof Ionicons.glyphMap; outline: keyof typeof Ionicons.glyphMap }> = {
            Главная: { focused: 'home', outline: 'home-outline' },
            Списание: { focused: 'trash', outline: 'trash-outline' },
            Склад: { focused: 'cube', outline: 'cube-outline' },
            Персонал: { focused: 'people', outline: 'people-outline' },
          };
          const icon = icons[route.name];
          return <Ionicons name={focused ? icon?.focused : icon?.outline} size={size} color={color} />;
        },
      })}>
        <Tab.Screen name="Главная" component={HomeScreen} />
        <Tab.Screen name="Списание" component={WriteOffScreen} />
        <Tab.Screen name="Склад" component={HomeScreen} />
        <Tab.Screen name="Персонал" component={HomeScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
